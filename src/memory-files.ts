import {
  formatIfMatch,
  normalizeMemoryFileResult,
  validateMemoryFileName,
  type AetherClient,
  type MemoryFileRequestInit,
} from "./client.js";
import { AetherError } from "./errors.js";
import type {
  MemoryFile,
  MemoryFileAppendOptions,
  MemoryFileAppendSectionOptions,
  MemoryFileDeleteOptions,
  MemoryFileDeleteResult,
  MemoryFileDiff,
  MemoryFileDiffOptions,
  MemoryFileGrepOptions,
  MemoryFileListOptions,
  MemoryFilePage,
  MemoryFileReadOptions,
  MemoryFileReplaceSectionOptions,
  MemoryFileVersions,
  MemoryFileVersionsOptions,
  MemoryFileWriteOptions,
  MemoryFileWriteResult,
  MemoryGrepResult,
} from "./models.js";

/** Content type of a whole-file `write` body. */
const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";

function checkExpectedVersion(expectedVersion: number | undefined): void {
  if (
    expectedVersion !== undefined &&
    (!Number.isInteger(expectedVersion) || expectedVersion < 1)
  ) {
    throw new AetherError("expectedVersion must be an integer >= 1");
  }
}

/**
 * Exactly one of `expectedVersion` / `create` for a write that replaces
 * content (`write`, `replaceSection`), mapped to its precondition header.
 */
function requiredPrecondition(
  expectedVersion: number | undefined,
  create: boolean | undefined,
): Pick<MemoryFileRequestInit, "ifMatch" | "ifNoneMatch"> {
  checkExpectedVersion(expectedVersion);
  const hasVersion = expectedVersion !== undefined;
  if (hasVersion === (create === true)) {
    throw new AetherError("pass exactly one of expectedVersion or create");
  }
  return hasVersion
    ? { ifMatch: formatIfMatch(expectedVersion!) }
    : { ifNoneMatch: "*" };
}

/** `If-Match` only when `expectedVersion` is given. */
function optionalPrecondition(
  expectedVersion: number | undefined,
): Pick<MemoryFileRequestInit, "ifMatch"> {
  checkExpectedVersion(expectedVersion);
  return expectedVersion === undefined ? {} : { ifMatch: formatIfMatch(expectedVersion) };
}

function checkSection(section: string): void {
  if (typeof section !== "string" || section.trim().length === 0) {
    throw new AetherError("section must be a non-blank string");
  }
}

/**
 * Named, versioned markdown files scoped to one entity — reached as
 * {@link Memory.files}.
 *
 * A file is read whole, by section (heading text or slug) or by page, and
 * written either whole (`write`, guarded by the version you read) or with
 * section-aware edits (`append`, `appendSection`, `replaceSection`). Every
 * version is kept (up to a retention limit) for `versions` and `diff`, and
 * `grep` searches the current versions line by line.
 *
 * Every call is scoped to the Memory's `entityId` and its client's partition
 * handle, and goes through the client's transport, retries and errors.
 * Writes carry an `Idempotency-Key` (reused across automatic retries), so a
 * retried `append` never appends twice.
 *
 * Read-modify-write:
 * ```typescript
 * const file = await memory.files.read("memory.md");
 * const next = edit(file.content);
 * try {
 *   await memory.files.write("memory.md", next, { expectedVersion: file.version });
 * } catch (err) {
 *   if (err instanceof VersionConflictError) {
 *     // someone else wrote first: re-read, re-apply, retry
 *   } else throw err;
 * }
 * ```
 */
export class MemoryFiles {
  /** The entity whose files this accessor reads and writes. */
  readonly entityId: string;
  private readonly client: AetherClient;

  /**
   * Usually reached as `memory.files` rather than constructed directly.
   *
   * @param client - The raw client every call goes through.
   * @param entityId - The entity whose files to read and write.
   */
  constructor(client: AetherClient, entityId: string) {
    this.client = client;
    this.entityId = entityId;
  }

  private filePath(name: string, suffix = ""): string {
    validateMemoryFileName(name);
    return `/memory/files/${encodeURIComponent(name)}${suffix}`;
  }

  private async send<T>(
    method: string,
    path: string,
    init: MemoryFileRequestInit,
  ): Promise<{ data: T; etag: string | null }> {
    return this.client.memoryFileRequest<T>(method, path, {
      ...init,
      query: { entity_id: this.entityId, ...init.query },
    });
  }

  /**
   * List this entity's current memory files, by name.
   *
   * @param options - Name prefix and paging.
   * @returns One {@link MemoryFilePage}; pass `next_cursor` back as `cursor`.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async list(options: MemoryFileListOptions = {}): Promise<MemoryFilePage> {
    return this.client.listMemoryFiles({
      entityId: this.entityId,
      prefix: options.prefix,
      limit: options.limit,
      cursor: options.cursor,
    });
  }

  /**
   * Read a memory file: the whole current version, an older `version`, one
   * `section` (by heading text or slug, including its heading line), or only
   * its `outline`. Large texts are paged: pass `next_offset` back as
   * `offset` while `truncated`. `sections` always carries the whole
   * version's outline.
   *
   * @param name - The file name, e.g. `"memory.md"`.
   * @param options - Version, section, outline and paging options.
   * @returns The {@link MemoryFile}; its `version` is what to pass as
   *   `expectedVersion` when writing back.
   * @throws {AetherError} If `name` is invalid.
   * @throws {AetherApiError} On non-2xx API response (404
   *   `memory_file_not_found` / `memory_file_version_not_found` /
   *   `memory_file_section_not_found`, 409 `memory_file_section_ambiguous`
   *   with `candidates` — select by slug instead).
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async read(name: string, options: MemoryFileReadOptions = {}): Promise<MemoryFile> {
    const path = this.filePath(name);
    const { data, etag } = await this.send<MemoryFile>("GET", path, {
      query: {
        version: options.version,
        section: options.section,
        outline: options.outline ? true : undefined,
        offset: options.offset,
        max_bytes: options.maxBytes,
      },
    });
    return normalizeMemoryFileResult(data, etag);
  }

  /**
   * Replace a file's whole content. Pass exactly one precondition:
   * `expectedVersion` (the version you read; a {@link VersionConflictError}
   * is thrown if someone wrote since) or `create: true` (the file must not
   * exist yet). Writing content identical to the current version is a no-op
   * that answers `unchanged: true`.
   *
   * @param name - The file name.
   * @param content - The new markdown content (up to 512 KiB).
   * @param options - Precondition, author label and idempotency key.
   * @returns The {@link MemoryFileWriteResult}.
   * @throws {AetherError} If `name` is invalid, or not exactly one of
   *   `expectedVersion` / `create` is given.
   * @throws {VersionConflictError} If the precondition failed.
   * @throws {AetherApiError} On other non-2xx API responses (413
   *   `memory_file_too_large`, …).
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async write(
    name: string,
    content: string,
    options: MemoryFileWriteOptions = {},
  ): Promise<MemoryFileWriteResult> {
    const path = this.filePath(name);
    const precondition = requiredPrecondition(options.expectedVersion, options.create);
    const { data, etag } = await this.send<MemoryFileWriteResult>("PUT", path, {
      query: { author: options.author || undefined },
      body: content,
      contentType: MARKDOWN_CONTENT_TYPE,
      ...precondition,
      idempotencyKey: options.idempotencyKey || true,
    });
    return normalizeMemoryFileResult(data, etag);
  }

  /**
   * Append text to the end of a file (a newline is added before it if the
   * file does not end with one, and after it if it lacks one). Applied
   * atomically to the current version, so no precondition is needed; pass
   * `expectedVersion` to require one anyway.
   *
   * @param name - The file name.
   * @param content - Non-empty text to append.
   * @param options - Precondition, `createIfMissing` (default `true`), author
   *   label and idempotency key.
   * @returns The {@link MemoryFileWriteResult}.
   * @throws {AetherError} If `name` is invalid or `content` is empty.
   * @throws {VersionConflictError} If `expectedVersion` is no longer current.
   * @throws {AetherApiError} On other non-2xx API responses.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async append(
    name: string,
    content: string,
    options: MemoryFileAppendOptions = {},
  ): Promise<MemoryFileWriteResult> {
    const path = this.filePath(name);
    if (!content) throw new AetherError("content must be non-empty");
    return this.patch(path, optionalPrecondition(options.expectedVersion), options, {
      op: "append",
      content,
      create_if_missing: options.createIfMissing ?? true,
    });
  }

  /**
   * Add lines to the end of a section's own body — under its heading, after
   * its last non-blank line and ahead of any sub-sections. A missing section
   * is created at the end of the file (heading `level`, default 2) unless
   * `createIfMissing` is `false`. No precondition is needed.
   *
   * @param name - The file name.
   * @param section - The section's heading text or slug.
   * @param content - Non-empty text to add.
   * @param options - Heading level for a created section, precondition,
   *   `createIfMissing` (default `true`), author label and idempotency key.
   * @returns The {@link MemoryFileWriteResult} (`section_created` when the
   *   section was new).
   * @throws {AetherError} If `name` is invalid, `section` is blank or
   *   `content` is empty.
   * @throws {VersionConflictError} If `expectedVersion` is no longer current.
   * @throws {AetherApiError} On other non-2xx API responses (409
   *   `memory_file_section_ambiguous`, 404 `memory_file_section_not_found`
   *   with `createIfMissing: false`, …).
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async appendSection(
    name: string,
    section: string,
    content: string,
    options: MemoryFileAppendSectionOptions = {},
  ): Promise<MemoryFileWriteResult> {
    const path = this.filePath(name);
    checkSection(section);
    if (!content) throw new AetherError("content must be non-empty");
    return this.patch(path, optionalPrecondition(options.expectedVersion), options, {
      op: "append_section",
      section,
      content,
      level: options.level ?? 2,
      create_if_missing: options.createIfMissing ?? true,
    });
  }

  /**
   * Replace a section's body (everything under its heading, including nested
   * sub-sections) with `content`; `""` clears it. The heading is kept. Pass
   * exactly one precondition: `expectedVersion` or `create: true`.
   *
   * @param name - The file name.
   * @param section - The section's heading text or slug.
   * @param content - The new body (may be empty).
   * @param options - Precondition, heading level for a created section,
   *   `createIfMissing` (default `true`), author label and idempotency key.
   * @returns The {@link MemoryFileWriteResult}.
   * @throws {AetherError} If `name` is invalid, `section` is blank, or not
   *   exactly one of `expectedVersion` / `create` is given.
   * @throws {VersionConflictError} If the precondition failed.
   * @throws {AetherApiError} On other non-2xx API responses.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async replaceSection(
    name: string,
    section: string,
    content: string,
    options: MemoryFileReplaceSectionOptions = {},
  ): Promise<MemoryFileWriteResult> {
    const path = this.filePath(name);
    checkSection(section);
    const precondition = requiredPrecondition(options.expectedVersion, options.create);
    return this.patch(path, precondition, options, {
      op: "replace_section",
      section,
      content,
      level: options.level ?? 2,
      create_if_missing: options.createIfMissing ?? true,
    });
  }

  private async patch(
    path: string,
    precondition: Pick<MemoryFileRequestInit, "ifMatch" | "ifNoneMatch">,
    options: { author?: string; idempotencyKey?: string },
    body: Record<string, unknown>,
  ): Promise<MemoryFileWriteResult> {
    const { data, etag } = await this.send<MemoryFileWriteResult>("PATCH", path, {
      query: { author: options.author || undefined },
      body: JSON.stringify(body),
      contentType: "application/json",
      ...precondition,
      idempotencyKey: options.idempotencyKey || true,
    });
    return normalizeMemoryFileResult(data, etag);
  }

  /**
   * List a file's retained versions, newest first.
   *
   * @param name - The file name.
   * @param options - `limit` (1–100).
   * @returns The {@link MemoryFileVersions}.
   * @throws {AetherError} If `name` is invalid.
   * @throws {AetherApiError} On non-2xx API response (404 `memory_file_not_found`).
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async versions(
    name: string,
    options: MemoryFileVersionsOptions = {},
  ): Promise<MemoryFileVersions> {
    const path = this.filePath(name, "/versions");
    const { data } = await this.send<MemoryFileVersions>("GET", path, {
      query: { limit: options.limit },
    });
    return { ...data, partition: data.partition ?? null, versions: data.versions ?? [] };
  }

  /**
   * Unified diff between two versions of a file (default: the previous
   * version against the current one). `from: 0` diffs against the empty file.
   *
   * @param name - The file name.
   * @param options - `from` (≥ 0), `to` (≥ 1) and `context` lines (default 3).
   * @returns The {@link MemoryFileDiff}; `diff` is the unified diff text.
   * @throws {AetherError} If `name` is invalid or a version is out of range.
   * @throws {AetherApiError} On non-2xx API response (404
   *   `memory_file_not_found` / `memory_file_version_not_found`).
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async diff(name: string, options: MemoryFileDiffOptions = {}): Promise<MemoryFileDiff> {
    const path = this.filePath(name, "/diff");
    if (options.from !== undefined && (!Number.isInteger(options.from) || options.from < 0)) {
      throw new AetherError("from must be an integer >= 0");
    }
    if (options.to !== undefined && (!Number.isInteger(options.to) || options.to < 1)) {
      throw new AetherError("to must be an integer >= 1");
    }
    const { data } = await this.send<MemoryFileDiff>("GET", path, {
      query: { from: options.from, to: options.to, context: options.context ?? 3 },
    });
    return { ...data, partition: data.partition ?? null };
  }

  /**
   * Search this entity's current memory files line by line.
   *
   * @param pattern - A literal substring, or a regular expression with
   *   `regex: true` (linear-time syntax: no back-references or look-around).
   * @param options - Matching options and an optional list of file names.
   * @returns The {@link MemoryGrepResult}.
   * @throws {AetherError} If `pattern` is empty.
   * @throws {AetherApiError} On non-2xx API response (400 `invalid_pattern`, …).
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async grep(pattern: string, options: MemoryFileGrepOptions = {}): Promise<MemoryGrepResult> {
    return this.client.grepMemoryFiles(pattern, {
      regex: options.regex,
      ignoreCase: options.ignoreCase,
      files: options.files,
      context: options.context,
      maxMatches: options.maxMatches,
      entityId: this.entityId,
    });
  }

  /**
   * Delete a file. By default a soft delete: the file disappears from list,
   * read, grep and search, and re-creating the name continues its version
   * numbering. `hard: true` irreversibly purges every version (use it for
   * erasure); the name then starts fresh at version 1.
   *
   * @param name - The file name.
   * @param options - `hard` and an optional `expectedVersion` precondition.
   * @returns The {@link MemoryFileDeleteResult}.
   * @throws {AetherError} If `name` is invalid or `expectedVersion` is not ≥ 1.
   * @throws {VersionConflictError} If `expectedVersion` is no longer current.
   * @throws {AetherApiError} On other non-2xx API responses (404 `memory_file_not_found`).
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async delete(
    name: string,
    options: MemoryFileDeleteOptions = {},
  ): Promise<MemoryFileDeleteResult> {
    const path = this.filePath(name);
    const precondition = optionalPrecondition(options.expectedVersion);
    const { data } = await this.send<MemoryFileDeleteResult>("DELETE", path, {
      query: { hard: options.hard ? true : undefined },
      ...precondition,
    });
    return { ...data, partition: data.partition ?? null };
  }
}
