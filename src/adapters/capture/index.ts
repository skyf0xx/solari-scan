export { CaptureAdapter } from "./capture-adapter.js";
export { FilesystemCaptureAdapter, FALLBACK_SANDBOX_ROOT, MAX_HASHABLE_BYTES } from "./filesystem-capture.js";
export { ProxyCaptureAdapter } from "./proxy-capture.js";
export { CaptureAdapterError } from "./errors.js";
export type {
  SandboxFileAccess,
  SandboxFsEntry,
  SandboxFsStat,
  SandboxGuestAccess,
  SandboxCommandHandle,
  SandboxCommandOptions,
  SandboxCommandChunk,
  SandboxRunResult,
} from "./sandbox-files.js";
