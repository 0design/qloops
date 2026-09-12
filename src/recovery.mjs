// Instructions for the calling agent; these never execute login, change a
// provider, lift permissions, or replay an uncertain external action.
export function recoveryAction(code) {
  switch (code) {
    case "INFERENCE_EXPIRED":
      return {type:"review_limits",message:"Inference job expired; review or start a fresh request. Do not reuse its reply."};
    case "STALE_INFERENCE":
      return {type:"review_inference",message:"Discard the stale reply and inspect the current run without submitting it again. Do not change scope or replay consumed jobs."};
    case "AUTH_REQUIRED":
      return { type: "configure_access", message: "Restore the configured provider or receiver's local authorization, then retry the explicit run. Keep credentials out of prompts and result files." };
    case "MISSING_EXECUTABLE":
    case "UNSUPPORTED_CLI":
      return { type: "configure_provider", message: "Configure an installed, reviewed CLI version. A provider change requires a new request and approval; no fallback is automatic." };
    case "UNSUPPORTED_NESTING":
    case "CLI_ENVIRONMENT_DENIED":
      return { type: "configure_caller", message: "Use an explicitly supported caller-owned handoff outside the active CLI session. Do not remove nesting guards. This result does not provision a broker." };
    case "PERMISSION_DENIED":
    case "SCOPE_DENIED":
      return { type: "review_permissions", message: "Review the denied scope or tool with the user; do not widen permissions automatically." };
    default:
      return null;
  }
}
