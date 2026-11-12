const ApiError = require('./ApiError');

/**
 * Runs at most `concurrent` tasks at once; the rest wait in line. A full line rejects new work with a 503
 * (and Retry-After) rather than letting a burst pile up for minutes behind slow carriers.
 */
const createLimiter = ({ concurrent, queue }) => {
  let running = 0;
  const waiting = [];
  const run = async (task) => {
    if (running >= concurrent) {
      if (waiting.length >= queue) {
        const error = new ApiError(503, 'Too many rate requests right now. Please retry shortly.');
        error.retryAfterSeconds = 5;
        throw error;
      }
      await new Promise((resolve) => waiting.push(resolve));
    } else {
      running += 1;
    }
    try {
      return await task();
    } finally {
      // Hand the slot straight to the next waiter so the cap can never be exceeded.
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    }
  };
  return { run, stats: () => ({ running, waiting: waiting.length }) };
};

/** Rejects if `promise` has not settled within `ms`. The underlying work is not cancelled. */
const withTimeout = (promise, ms, label) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not answer within ${Math.round(ms / 1000)}s`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

module.exports = { createLimiter, withTimeout };
