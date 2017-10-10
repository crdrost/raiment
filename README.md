# Raiment
Raiment builds parallel Node.js clusters and caches I/O, stealing some good ideas from
[Cloud Haskell][hswiki-cloud-haskell] and [Haxl][hackage-haxl], the former of which steals its good 
ideas from Erlang.

The idea is that with raiment, you define a *weave* with a source tree, which needs to be replicated
to each host. A weave consists of:

  - a Node.js process, often identified with *the* weave,
  - a directory of *thread types*,
  - a dictionary of *I/O libraries*, and
  - a storage backend.

Each host can then run one or more of these weaves -- since JavaScript is single-threaded we need
the OS to provide parallelism. You can use [the Node.js `child_process` module][node-child-process]
or we can work on implementing support for [the `npool` package][npm-npool] and add that as a
dependency or so. Inside the weave, a bunch of *threads* run and communicate by message-passing;
they can be spawned with a type and an argument by the weave, which uses its storage backend to
serialize the threads as they were initialized. If the weave dies, it can be resumed from the state
of its storage backend. We steal the thread semantics from Cloud Haskell, which is basically a lot
of more-modern thinking about the Erlang concurrency model.

The threads are dressed-up [`async` functions][mdn-async-fn], this was the original motivation for
calling this package “raiment.” Specifically when we dress up an `async` function we enclose it in
an object,

    module.exports = require('raiment').thread({
        uses: ['db', 'mailbox', 'log'],
        does: async function (params) {
            // code goes here.
        }
    })

The `uses` array refers to keys in your weave's dictionary of I/O libraries, stating that those
commands should be mixed in to this thread: so within the async function `this.db` and 
`this.mailbox` and `this.log` are all defined. However: the weave intercepts the thread's
communication with your backend, and it intercepts your response, storing these both in a per-thread
cache. (It hands a promise back to the thread for these operations, so the thread can wait on that
with `await`.) *Anything which is already in the cache is returned preferentially.* This gives you
some amazing superpowers: it means that you can dump the cache and thereby get reproducible I/O from
the thread's perspective: this gives you the power to write unit tests without "mocking" anything,
and it allows you to dump the cache on errors to try and debug your threads. These ideas were stolen
from the Haxl library.

I am not yet decided on whether the thread actually accepts params. It strikes me that we have two
independent means by which information gets into a thread: either by these input params, or by 
waiting on a channel, possibly its own mailbox. Potentially this should be unified. However I am not
sure how to guarantee resumability in that context.

# I/O and killability
The routing/caching middleware which (ideally) handles all of the I/O in a thread is called the 
*weft* and it serves an additional purpose: Node.js does not give a great way to kill the ongoing
processes in a running application, though [there are methods][github-event-loop-issue] to get at
this information. When a thread is “killed” we actually just disconnect it from the weft with any
attempt to contact the weft met by an exception. 





[hswiki-cloud-haskell]: https://wiki.haskell.org/Cloud_Haskell "HaskellWiki: Cloud Haskell"
[hackage-haxl]: https://hackage.haskell.org/package/haxl "Hackage: Haxl"
[node-child_process]: https://nodejs.org/api/child_process.html "Node.js docs: child_process"
[npm-npool]: https://www.npmjs.com/package/npool "NPM package: npool"
[mdn-async-fn]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/async_function 
    "MDN: async function"
[github-event-loop-issue]: https://github.com/nodejs/node/issues/1128 
    "Github @nodejs/node: feature request: a way to inspect what's in the event loop"
