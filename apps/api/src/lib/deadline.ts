/** Bound a probe without leaving its timer alive after a fast success/failure. */
export async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Probe timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
