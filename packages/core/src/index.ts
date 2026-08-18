export type { SqlDriver, SqlValue, Row } from './db/driver.ts'
export {
  openDeviceDatabase,
  openEphemeralDatabase,
  UnencryptedDeviceDatabaseError,
} from './db/device-key.ts'
export type {
  DeviceKeyProvider,
  DeviceDriverFactory,
  StorageProtection,
} from './db/device-key.ts'
export { LOCAL_SCHEMA, DEVICE_ONLY_TABLES, MIRROR_TABLES } from './db/schema.ts'
export { Outbox, syncStatus, MAX_ATTEMPTS } from './outbox.ts'
export type { OutboxRow, OutboxState, EnqueueInput, SyncTone } from './outbox.ts'
export { ScanSession } from './scan.ts'
export type { ScanResult, ScanOutcome, ScanSessionOptions } from './scan.ts'
export { SyncEngine, TransportError } from './sync.ts'
export type { Transport, SubmitResult, FlushReport } from './sync.ts'
export { PullApplier } from './pull.ts'
export type { PullPayload, ApplyReport } from './pull.ts'
export { buildPullList, progressSummary } from './pull-list.ts'
export { parseKitList, matchKitList, normalise, similarity, editDistance, compact } from './kit-list.ts'
export { checkAvailability, replySummary } from './availability.ts'
export type { AvailabilityLine, AvailabilitySummary, AvailabilityState } from './availability.ts'
export type { ParsedLine, MatchedLine, CatalogueItem, MatchConfidence } from './kit-list.ts'
export type { PullListItem, PullListView, ShelfGroup } from './pull-list.ts'
export { parseCsv, guessMapping, readRows, planImport } from './csv-import.ts'
export type {
  CsvTable, ColumnMapping, FieldName, ImportRow, ImportPlan, ReviewedRow, RowVerdict,
} from './csv-import.ts'
export { PhotoStore, pairBySide, DEFAULT_BUDGET_BYTES } from './photos.ts'
export type { PhotoRow, PhotoSide, PhotoPair, CaptureInput, CaptureResult } from './photos.ts'
export { FEEDBACK, ERROR_FEEDBACK, firstBuzzMs, hapticDurationMs } from './feedback.ts'
export type { FeedbackSpec } from './feedback.ts'
