export function tokenRecord(date, model, input = 0, output = 0, cache = 0, write = 0) {
  if (!date || !model || ![input, output, cache, write].every(n => Number.isSafeInteger(n) && n >= 0)) {
    throw new Error('Invalid AGY token record');
  }
  return { date, model, inputTok: input, outputTok: output, cacheReadTok: cache, cacheCreateTok: write };
}
