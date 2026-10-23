// Original reference files stay on this device. Server upload happens only on
// an explicit AI analysis request; portable JSON contains metadata, not files.
let database: Promise<IDBDatabase> | undefined;
function db() {
  if (!database)
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("tradiative-reference-files", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("sources");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        database = undefined;
        reject(request.error);
      };
    });
  return database;
}
export async function saveSourceFile(id: string, file: Blob) {
  const connection = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = connection.transaction("sources", "readwrite");
    tx.objectStore("sources").put(file, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
export async function readSourceFile(id: string) {
  const connection = await db();
  return new Promise<Blob | undefined>((resolve, reject) => {
    const request = connection
      .transaction("sources", "readonly")
      .objectStore("sources")
      .get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export function imageData(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
