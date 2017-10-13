/* weft.js
 *
 * (c) 2017 CR Drost
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of
 * the MPL was not distributed with this file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
The *weft* is the part of Raiment which forms the "sturdy backbone", and is analogous to the Haxl
library that Facebook created for Haskell. A given weft manages a bunch of caches and responds to
certain (namespaced) messages like `raiment/new_thread`.

You are encouraged to write *weft plugins* to handle everything that is nondeterministic or I/O
related: interacting with a database, getting the current date, random numbers, and so forth. To do
this, the weave will load your plugin by having access to it here:

    new Weave({
       // other configurations...
       io: [
         require('standalone-plugin'),
         require('needs-more-configuration')({some: 'args'}),
         your_plugin
       ]
     })

Your plugin should be an object of two fields:

  - `plugin.namespace` is a string defining the namespace that the plugin creates. Your requests
    will secretly be serialized to `[ns + '.' + method, arguments...]`. Your namespace *can* have
    subnamespaces separated by dots and this will work the obvious way.
  - `plugin.init(router)` is an asynchronous function. You will be given an object `router` with
    sychronous methods `registerSync(method, [opts,] handler)` and `registerAsync(method, [opts,] handler)`
    that you can use to add methods to the weft. The promise should resolve when you are done
    registering methods; you won't be able to register anything further afterwards.

The optional `opts` object is meant to configure weft options. The only one right now is the
option `{cacheBuster: true}` (default is `false`). This does not quite disable caching: it makes
subsequent calls to the method distinct *even if the parameters are the same*, but the caching
still happens. It does this by adding integer request numbers to the requests that the thread is
making, but then strips them out before handing the parameters to your handler function. The goal
here is that sometimes things like "listen for the `dataAvailable` message" can be cached for
long-term replays and tests, but *will likely be repeated* many times in one thread.
*/

// TODO: the following 5 lines are heresy. gimme Buffers and Errors at minimum.
const serial = {
  encode: x => new Buffer(JSON.stringify(x), 'utf8'),
  decode: x => JSON.parse(x.toString('utf8')),
  key: (ns, method, args) => JSON.stringify([ns+'.'+method,...args])
};

// since serializer doesn't handle errors we have to do that here.
function obj_from_err(error) {
  let obj = Object.create(null),
      name_match = err_name_regex.exec('' + error.constructor);
  obj.type = typeof global[name_match[1]] === 'function'? name_match[1] : 'Error';
  for (let key of error_props) {
    if (error.hasOwnProperty(key)) {
      obj[key] = error[key];
    }
  }
  return obj;
}
function err_from_obj(obj) {
  let t = obj.type, err;
  if (typeof t === 'string' && /Error$/.exec(t) && typeof global[t] === 'function') {
    err = new global[t]();
  }
  for (let key of error_props) {
    if (obj.hasOwnProperty(key)) {
      err[key] = obj[key];
    }
  }
  return err;
}

// anyway take the cached error/result and emit it.
function resolve([err, result]) {
  if (err !== null) {
    throw err instanceof Error? err : err_from_obj(err);
  }
  return result;
}

class Weft {
  constructor(weave) {
    this.mixins = new Map();
    this.weave = weave;
  }
  addPlugin(plugin) {
    // Add the given plugin to this weft's mixins. Basically lets the plugin guide the action.
    // Since our decoration of a thread happens at thread creation time we cannot easily modify the
    // extant threads with new methods, so we insist that everything be available as part of weave
    // initialization.

    let ns = plugin.namespace, closed = false;
    if (!this.mixins.has(ns)) {
      this.mixins.set(ns, Object.create(null));
    }
    plugin.init({
      registerSync: (method, opts, handler) => {
        if (closed) {
          throw new Error('Raiment.Weft: Plugin already initialized; cannot register any more methods.');
        }
        this.register(true, ns, method, opts, handler)
      },
      registerAsync: (method, opts, handler) => {
        if (closed) {
          throw new Error('Raiment.Weft: Plugin already initialized; cannot register any more methods.');
        }
        this.register(false, ns, method, opts, handler)
      }
    }).then(_ => closed = true);
  }
  register(sync, namespace, method, opts, handler) {
    // Register a new I/O handler with this weft. We wrap the handler in caching code and so forth.

    let cache = this.weave.cache,           // the weave's Map ThreadID (Map Query ResponseBuffer)
        mixin = this.mixins.get(namespace); // the weft's mixin that we are inserting this into.

    // opts is an optional configuration object: if that configuration was not included then the 
    // handler function is stored incorrectly in opts, let's fix that.
    if (typeof opts === 'function') {
      handler = opts;
      opts = {};
    }
    // the only important option right now is the cacheBuster option.
    let cacheBuster = opts.cacheBuster || false;

    // With that bit of data marshalling we are ready to add the method to the mixin.
    mixin[method] = function (...args) {
      let thread_id = this.thread_id,                // ID of current thread calling this method
          key = serial.key(namespace, method, args), // A unique key for this request
          cached, // the ResponseBuffer loaded from the cache
          result; // the deserialized/serializable result from this ResponseBuffer.

      // If this method has a cacheBuster, we add -${requestNum} to the Query to make it unique.
      if (cacheBuster) {
        // we store these counts indexed by request on the thread-local mixin object `this`. By
        // being thread-local we do not care how the Node.js scheduler picks up threads; by being
        // method-local we also allow people to, say, insert debugging I/O when they replay the
        // thread. When the thread dies its cacheBuster and such should get garbage-collected.
        let count = this.cacheBuster.get(key);
        if (typeof count !== 'number') {
          count = 1;
        }
        this.cacheBuster.set(key, count + 1);
        key = key + '-' + count;
      }

      // try to respond directly out of the cache.
      if (cached = cache.get(thread_id).get(key)) {
        result = serial.decode(cached);
        return sync? resolve(result) :
            Promise.resolve(null).then(_ => resolve(result));
      }
      // if that's impossible, then we have to run `handler(...args)` looking for a response, and
      // how we collect that response depends a lot on whether the method is synchronous or
      // asynchronous.
      if (sync) {
        try {
          result = [null, handler(...args, thread_id)];
        } catch (e) {
          result = [obj_from_err(e), null];
        }
        cache.set(key, serial.encode([err, result]));
        return resolve(result);
      }
      return Promise.resolve(handler(...args, thread_id))
          .then(
            value => [null, value],
            err => [obj_from_err(err), null]
          )
          .then(x => {
            cache.set(key, serial.encode(x));
            resolve(x);
          });
    }
  }
  dress(proto_thread, thread_id) {
    for (let [ns, mixin] of this.mixins) {
      let curr = proto_thread;
      if (ns !== '') {
        for (let subdir of ns.split('.')) {
          if (!curr[subdir]) {
            curr[subdir] = Object.create(null);
          }
          curr = curr[subdir];
        }
      }
      curr.thread_id = thread_id;
      curr.cacheBuster = new Map();
      for (let key of mixin) {
        curr[key] = mixin[key];
      }
    }
  }
}
