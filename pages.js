const defaultDraft = { count: 0, bytes: 0, revision: 0 };

export class DraftChangedError extends Error {}

export function openStorage() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("timed-page-scanner", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("pages");
      request.result.createObjectStore("draft");
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Close any other scanner tabs and reload."));
  });
}

function read(database, storeName, key) {
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName).objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getDraft(database) {
  return await read(database, "draft", "current") ?? defaultDraft;
}

export async function getPage(database, number) {
  const photo = await read(database, "pages", number);
  if (!photo) throw new Error(`Page ${number} could not be read.`);
  return photo;
}

// Commit the JPEG and the counter together. A second open tab may never overwrite a stale draft.
function changeDraft(database, expectedRevision, change) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(["draft", "pages"], "readwrite");
    const drafts = transaction.objectStore("draft");
    const pages = transaction.objectStore("pages");
    let result;
    let failure;
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Storage was interrupted."));
    const request = drafts.get("current");
    request.onsuccess = () => {
      const current = request.result ?? defaultDraft;
      if (current.revision !== expectedRevision) {
        failure = new DraftChangedError("These photos changed in another tab. The saved list has been refreshed.");
        transaction.abort();
        return;
      }
      change(pages, current, (count, bytes) => {
        result = { count, bytes, revision: current.revision + 1 };
        drafts.put(result, "current");
      });
    };
  });
}

export function appendPage(database, revision, photo) {
  return changeDraft(database, revision, (pages, current, finish) => {
    const number = current.count + 1;
    pages.add(photo, number);
    finish(number, current.bytes + photo.size);
  });
}

export function replacePage(database, revision, number, photo) {
  return changeDraft(database, revision, (pages, current, finish) => {
    const request = pages.get(number);
    request.onsuccess = () => {
      if (!request.result) {
        pages.transaction.abort();
        return;
      }
      pages.put(photo, number);
      finish(current.count, current.bytes - request.result.size + photo.size);
    };
  });
}

export function clearDraft(database, revision) {
  return changeDraft(database, revision, (pages, _current, finish) => {
    pages.clear();
    finish(0, 0);
  });
}
