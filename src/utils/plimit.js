// ./utils/plimit.js
'use strict';

function pLimit(concurrency = 3) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('pLimit: concurrency debe ser un entero >= 1');
  }

  const queue = [];
  let activeCount = 0;

  const schedule = typeof queueMicrotask === 'function'
    ? queueMicrotask
    : (fn) => setTimeout(fn, 0);

  const drain = () => {
    // Intenta iniciar tantas tareas como slots libres haya
    while (activeCount < concurrency && queue.length > 0) {
      const job = queue.shift();
      activeCount++;
      Promise.resolve()
        .then(() => job.fn(...job.args))
        .then(job.resolve, job.reject)
        .finally(() => {
          activeCount--;
          // Reprograma el siguiente drenado en microtarea
          schedule(drain);
        });
    }
  };

  const limit = (fn, ...args) => {
    if (typeof fn !== 'function') {
      throw new TypeError('pLimit: el primer argumento debe ser una función');
    }
    return new Promise((resolve, reject) => {
      queue.push({ fn, args, resolve, reject });
      // Dispara el drenado (no bloqueante)
      schedule(drain);
    });
  };

  // Métricas opcionales para debug/observabilidad
  Object.defineProperties(limit, {
    activeCount:   { get: () => activeCount },
    pendingCount:  { get: () => queue.length },
    concurrency:   { get: () => concurrency }
  });

  return limit;
}

module.exports = pLimit;
