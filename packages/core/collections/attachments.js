import Collection from "./collection";
import id from "../utils/id";
import { deleteItem, hasItem } from "../utils/array";
import hosts from "../utils/constants";
import {
  checkIsUserPremium,
  EV,
  EVENTS,
  sendAttachmentsProgressEvent,
} from "../common";
import dataurl from "../utils/dataurl";
import dayjs from "dayjs";
import setManipulator from "../utils/set";

export default class Attachments extends Collection {
  constructor(db, name, cached) {
    super(db, name, cached);
    this.key = null;
  }

  merge(remoteAttachment) {
    if (remoteAttachment.deleted)
      return this._collection.addItem(remoteAttachment);

    const id = remoteAttachment.id;
    let localAttachment = this._collection.getItem(id);

    if (localAttachment && localAttachment.noteIds) {
      remoteAttachment.noteIds = setManipulator.union(
        remoteAttachment.noteIds,
        localAttachment.noteIds
      );
    }

    return this._collection.addItem(remoteAttachment);
  }

  /**
   *
   * @param {{
   *  iv: string,
   *  length: number,
   *  alg: string,
   *  hash: string,
   *  hashType: string,
   *  filename: string,
   *  type: string,
   *  salt: string,
   *  chunkSize: number,
   *  key: {}
   * }} attachment
   * @param {string} noteId Optional as attachments will be parsed at extraction time
   * @returns
   */
  async add(attachment, noteId) {
    if (!attachment) return console.error("attachment cannot be undefined");
    if (!attachment.hash) throw new Error("Please provide attachment hash.");

    const oldAttachment = this.all.find(
      (a) => a.metadata.hash === attachment.hash
    );
    if (oldAttachment) {
      if (!noteId || oldAttachment.noteIds.includes(noteId)) return;

      oldAttachment.noteIds.push(noteId);
      oldAttachment.dateDeleted = undefined;
      return this._collection.updateItem(oldAttachment);
    }

    const {
      iv,
      length,
      alg,
      hash,
      hashType,
      filename,
      salt,
      type,
      key,
      chunkSize,
    } = attachment;

    if (
      !iv ||
      !length ||
      !alg ||
      !hash ||
      !hashType ||
      !filename ||
      !salt ||
      !chunkSize ||
      !key
    ) {
      console.error("Attachment invalid:", attachment);
      throw new Error("Could not add attachment: all properties are required.");
    }

    const encryptedKey = await this._encryptKey(key);
    const attachmentItem = {
      type: "attachment",
      id: id(),
      noteIds: noteId ? [noteId] : [],
      iv,
      salt,
      length,
      alg,
      key: encryptedKey,
      chunkSize,
      metadata: {
        hash,
        hashType,
        filename,
        type: type || "application/octet-stream",
      },
      dateCreated: Date.now(),
      dateEdited: undefined,
      dateUploaded: undefined,
      dateDeleted: undefined,
    };
    return this._collection.addItem(attachmentItem);
  }

  async generateKey() {
    await this._getEncryptionKey();
    return await this._db.storage.generateRandomKey();
  }

  async decryptKey(key) {
    const encryptionKey = await this._getEncryptionKey();
    const plainData = await this._db.storage.decrypt(encryptionKey, key);
    return JSON.parse(plainData);
  }

  async delete(hash, noteId) {
    const attachment = this.all.find((a) => a.metadata.hash === hash);
    if (!attachment || !deleteItem(attachment.noteIds, noteId)) return;
    if (!attachment.noteIds.length) {
      attachment.dateDeleted = Date.now();
      EV.publish(EVENTS.attachmentDeleted, attachment);
    }
    return await this._collection.updateItem(attachment);
  }

  async remove(hash, localOnly) {
    const attachment = this.all.find((a) => a.metadata.hash === hash);
    if (!attachment) return false;
    if (await this._db.fs.deleteFile(hash, localOnly)) {
      await this._collection.deleteItem(attachment.id);
      return true;
    }
    return false;
  }

  /**
   * Get specified type of attachments of a note
   * @param {string} noteId
   * @param {"files"|"images"|"all"} type
   * @returns
   */
  ofNote(noteId, type) {
    let attachments = [];

    if (type === "files") attachments = this.files;
    else if (type === "images") attachments = this.images;
    else if (type === "all") attachments = this.all;

    return attachments.filter((attachment) =>
      hasItem(attachment.noteIds, noteId)
    );
  }

  exists(hash) {
    const attachment = this.all.find((a) => a.metadata.hash === hash);
    return !!attachment;
  }

  /**
   * @param {string} hash
   * @returns {Promise<string>} dataurl formatted string
   */
  async read(hash) {
    const attachment = this.all.find((a) => a.metadata.hash === hash);
    if (!attachment) return;

    const key = await this.decryptKey(attachment.key);
    const data = await this._db.fs.readEncrypted(
      attachment.metadata.hash,
      key,
      {
        chunkSize: attachment.chunkSize,
        iv: attachment.iv,
        salt: attachment.salt,
        length: attachment.length,
        alg: attachment.alg,
        outputType: "base64",
      }
    );
    return dataurl.fromObject({ type: attachment.metadata.type, data });
  }

  attachment(hashOrId) {
    return this.all.find(
      (a) => a.id === hashOrId || a.metadata.hash === hashOrId
    );
  }

  markAsUploaded(id) {
    const attachment = this.all.find((a) => a.id === id);
    if (!attachment) return;
    attachment.dateUploaded = Date.now();
    return this._collection.updateItem(attachment);
  }

  async save(data, type) {
    const key = await this._db.attachments.generateKey();
    const metadata = await this._db.fs.writeEncrypted(null, data, type, key);
    return { key, metadata };
  }

  async downloadImages(noteId) {
    const attachments = this.images.filter((attachment) =>
      hasItem(attachment.noteIds, noteId)
    );
    try {
      for (let i = 0; i < attachments.length; i++) {
        const attachment = attachments[i];
        await this._downloadMedia(attachment, {
          total: attachments.length,
          current: i,
          groupId: noteId,
        });
      }
    } finally {
      sendAttachmentsProgressEvent("download", noteId, attachments.length);
    }
  }

  async _downloadMedia(attachment, { total, current, groupId }, notify = true) {
    const { metadata, chunkSize } = attachment;
    const filename = metadata.hash;

    sendAttachmentsProgressEvent("download", groupId, total, current);
    const isDownloaded = await this._db.fs.downloadFile(
      groupId,
      filename,
      chunkSize,
      metadata
    );
    if (!isDownloaded) return;

    const src = await this.read(metadata.hash);
    if (!src) return;

    if (notify)
      EV.publish(EVENTS.mediaAttachmentDownloaded, {
        groupId,
        hash: metadata.hash,
        src,
      });

    return src;
  }

  async cleanup() {
    const now = dayjs().unix();
    for (const attachment of this.deleted) {
      if (dayjs(attachment.dateDeleted).add(7, "days").unix() < now) continue;

      const isDeleted = await this._db.fs.deleteFile(attachment.metadata.hash);
      if (!isDeleted) continue;

      await this._collection.removeItem(attachment.id);
    }
  }

  get pending() {
    return this.all.filter(
      (attachment) =>
        (attachment.dateUploaded <= 0 || !attachment.dateUploaded) &&
        attachment.noteIds.length > 0
    );
  }

  get deleted() {
    return this.all.filter((attachment) => attachment.dateDeleted > 0);
  }

  get images() {
    return this.all.filter((attachment) =>
      attachment.metadata.type.startsWith("image/")
    );
  }

  get files() {
    return this.all.filter(
      (attachment) => !attachment.metadata.type.startsWith("image/")
    );
  }

  get all() {
    return this._collection.getItems();
  }

  /**
   * @private
   */
  async _encryptKey(key) {
    const encryptionKey = await this._getEncryptionKey();
    const encryptedKey = await this._db.storage.encrypt(
      encryptionKey,
      JSON.stringify(key)
    );
    return encryptedKey;
  }

  /**
   * @private
   */
  async _getEncryptionKey() {
    this.key = await this._db.user.getAttachmentsKey();
    if (!this.key)
      throw new Error(
        "Failed to get user encryption key. Cannot cache attachments."
      );
    return this.key;
  }
}
