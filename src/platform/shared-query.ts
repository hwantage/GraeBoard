export type SharedQuery<T> = {
  controller: AbortController;
  promise: Promise<T>;
  consumers: Set<object>;
};

// A cancelled subscription releases only its own interest in the shared read.
// Abort the network request when its final consumer leaves.
export function joinQuery<T>(work: SharedQuery<T>, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.resolve(undefined);
  const consumer = {};
  work.consumers.add(consumer);
  return new Promise<T | undefined>((resolve, reject) => {
    const release = () => {
      work.consumers.delete(consumer);
      signal?.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      release();
      if (!work.consumers.size) work.controller.abort();
      resolve(undefined);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    work.promise.then(
      (value) => {
        release();
        resolve(value);
      },
      (error: unknown) => {
        release();
        reject(error);
      },
    );
  });
}
