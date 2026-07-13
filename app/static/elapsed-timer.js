(function(root){
  'use strict';

  function defaultNow(){
    if(root.performance && typeof root.performance.now === 'function'){
      return root.performance.now();
    }
    return Date.now();
  }

  function formatElapsed(startedAt, currentTime){
    return (Math.max(0, currentTime - startedAt) / 1000).toFixed(1);
  }

  function start(options){
    var opts = options || {};
    var now = typeof opts.now === 'function' ? opts.now : defaultNow;
    var schedule = typeof opts.setIntervalFn === 'function' ? opts.setIntervalFn : root.setInterval;
    var cancel = typeof opts.clearIntervalFn === 'function' ? opts.clearIntervalFn : root.clearInterval;
    var onTick = typeof opts.onTick === 'function' ? opts.onTick : function(){};
    var startedAt = typeof opts.startedAt === 'number' ? opts.startedAt : now();
    var timerId = null;
    var stopped = false;

    function elapsed(){
      return formatElapsed(startedAt, now());
    }

    function tick(){
      onTick(elapsed());
    }

    tick();
    timerId = schedule(tick, typeof opts.intervalMs === 'number' ? opts.intervalMs : 100);

    return {
      startedAt: startedAt,
      elapsed: elapsed,
      stop: function(){
        if(!stopped){
          stopped = true;
          cancel(timerId);
        }
        return elapsed();
      }
    };
  }

  root.ElapsedTimer = {
    formatElapsed: formatElapsed,
    start: start
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
