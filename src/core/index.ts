/**
 * Lens core — public programmatic API.
 *
 * The CLI, the MCP server and third-party tooling all consume this surface. If a
 * capability is not reachable from here, it is not a Lens capability.
 */

export { loadConfig, findProjectRoot, resolveViewportProfile, CONFIG_FILE_NAMES, type ResolvedConfig, type LoadConfigOptions } from './config/load.js';
export { lensConfigSchema, DEFAULT_VIEWPORT_PROFILES, DEFAULT_RESPONSIVE_ORDER, type LensConfig, type ViewportProfile } from './config/schema.js';

export { LensError, LensErrorCode, LensErrors, isLensError, toLensError, assertLens, type LensErrorInit, type LensErrorScope } from './errors.js';

export { LensSession, type SessionInit, type OpenResult } from './session.js';
export { BrowserRuntime, type ManagedPage, type RuntimeStatus } from './browser/runtime.js';
export { provisionBrowser, lensCacheDir, type ProvisionedBrowser, type BrowserSource } from './browser/provision.js';

export { SnapshotService, renderTree, parseAriaYaml, type PageSnapshot, type InteractiveElement, type SnapshotOptions, type SnapshotNode } from './observe/snapshot.js';
export { ConsoleCollector, type ConsoleEntry, type ConsoleLevel, type ConsoleSummary } from './observe/console.js';
export { NetworkCollector, type NetworkEntry, type NetworkSummary, type NetworkClassification } from './observe/network.js';

export { ActionService, type ActionKind, type ActionParams, type ActionResult, type ActionContext } from './act/actions.js';
export { TargetResolver, parseTarget, describeTarget, similarity, type TargetSpec, type ResolvedTarget } from './act/resolve.js';
export { isSafeUploadPath } from './act/files.js';

export { ScreenshotService, type ScreenshotRequest, type ScreenshotResult, type ScreenshotScope, type ElementTarget } from './capture/screenshot.js';
export { OverlayLayer, type BannerOptions, type CalloutOptions, type HighlightOptions } from './capture/overlay.js';
// (export enabled when the module lands) export { VideoRecorder, type RecordingOptions, type RecordingState, type ChapterMarker, type RecordedArtifact } from './capture/video.js';
// (export enabled when the module lands) export { TraceRecorder } from './capture/trace.js';
// (export enabled when the module lands) export { compareImages, writeDiffArtifacts, type CompareOptions, type CompareResult } from './capture/diff.js';
export { readImageInfo, type ImageInfo } from './capture/image-info.js';
export { findFfmpeg, provisionPlaywrightFfmpeg, convertVideo, probeVideo, ffmpegAvailable, type FfmpegHandle } from './capture/ffmpeg.js';

export { VisualReviewer, VISUAL_CHECKS, type VisualCheck, type VisualReviewOptions, type VisualReviewResult, type CheckSummary } from './review/visual.js';
export { pageProbe, type PageProbeResult, type ProbeInput } from './review/probe.js';
// (export enabled when the module lands) export { ResponsiveReviewer, type ResponsiveOptions, type ResponsiveRun, type ViewportResult } from './review/responsive.js';
// (export enabled when the module lands) export { BaselineService, type BaselineUpdateResult, type BaselineCompareResult } from './review/baseline.js';
export { computeVerdict, countSeverities, verdictIcon, writeReport } from './artifacts/report.js';
export { verdictLabel, worstVerdict, summarizeFindings, finding, type Finding, type FindingElement, type FindingSeverity, type Verdict } from './review/types.js';

// (export enabled when the module lands) export { runFlow, type FlowDefinition, type FlowStep, type FlowResult, type StepResult, type StepStatus } from './flow/schema.js';
// (export enabled when the module lands) export { loadFlow, discoverFlows, parseFlowJson, type LoadFlowOptions } from './flow/load.js';

// (export enabled when the module lands) export { ShowcaseRunner, type ShowcaseRunOptions, type ShowcaseResult, type ShowcaseAttempt } from './showcase/runner.js';
// (export enabled when the module lands) export { loadPlan, validatePlan, planSummary, type ShowcasePlan, type ShowcaseStep, type ShowcaseBrief } from './showcase/plan.js';
// (export enabled when the module lands) export { reviewRecording, type RecordingReview, type RecordingReviewInput } from './showcase/selfreview.js';
// (export enabled when the module lands) export { buildDemoData, type DemoDataSet, type DemoDataRecord } from './showcase/demo-data.js';

// (export enabled when the module lands) export { PreviewService, type PreviewRequest, type PreviewResult, type PreviewKind } from './preview/generate.js';
// (export enabled when the module lands) export { PREVIEW_SIZES, type PreviewSizeName } from './preview/sizing.js';
// (export enabled when the module lands) export { injectMetadata, detectMetadataTargets, type MetadataProfile, type InjectResult } from './preview/metadata.js';

export { detectProject, devServerHints, FRAMEWORK_RULES, type ProjectProfile, type PackageManagerName } from './detect/project.js';
// (export enabled when the module lands) export { probeEnvironment, type EnvironmentReport, type CheckState } from './detect/environment.js';

export { ArtifactStore, ARTIFACT_KINDS, type ArtifactKind } from './artifacts/paths.js';
export { SessionLog, type SessionRecord, type SessionAction, type SessionArtifactRef } from './artifacts/session.js';

export { classifyOrigin, describeOrigin, checkNavigation, checkPermission, summarizePolicy, isLocalHost, type Decision, type OriginClass, type PermissionKey } from './security/policy.js';
// (export enabled when the module lands) export { redactText, redactValue, isSensitiveName, isSensitiveInputType, REDACTION } from './security/redact.js';

// (export enabled when the module lands) export { LensDaemon, type DaemonOptions } from '../daemon/server.js';
// (export enabled when the module lands) export { connectOrStart, DaemonClient, type DaemonHandle, type RpcResponse } from '../daemon/client.js';
// (export enabled when the module lands) export { RpcMethods, type RpcMethod, type RpcRequest } from '../daemon/protocol.js';
