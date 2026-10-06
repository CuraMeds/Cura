import { useEffect, useMemo, useState } from "react";
import { exportClaims, processClaim } from "./api/client";
import type { ClaimResponse } from "./types/api";
import "./App.css";

type AuthView = "login" | "signup";
type PageView = "process" | "export";
type ProcessStatus = "idle" | "running" | "success" | "failed";

type StageStatus = "pending" | "active" | "completed" | "warning" | "failed";

interface Stage {
  id: string;
  title: string;
  status: StageStatus;
  detail: string;
}

const stageTemplates: Stage[] = [
  {
    id: "input",
    title: "Input received",
    status: "pending",
    detail: "Clinical note accepted for processing",
  },
  {
    id: "analysis",
    title: "Clinical note analysed",
    status: "pending",
    detail: "Diagnosis and clinical context extracted",
  },
  {
    id: "diagnosis",
    title: "Diagnoses extracted",
    status: "pending",
    detail: "Potential ICD keywords identified",
  },
  {
    id: "mapping",
    title: "ICD-10 mapping performed",
    status: "pending",
    detail: "ICD suggestions matched against the note",
  },
  {
    id: "medications",
    title: "Medications identified",
    status: "pending",
    detail: "Drug names and formulary coverage checked",
  },
  {
    id: "audit",
    title: "Audit rules evaluated",
    status: "pending",
    detail: "NHIA and G-DRG audit checks completed",
  },
  {
    id: "tariff",
    title: "Tariff calculation performed",
    status: "pending",
    detail: "G-DRG amount computed with add-ons and penalties",
  },
  {
    id: "claim",
    title: "Claim prepared",
    status: "pending",
    detail: "Claim record built and persisted",
  },
  {
    id: "complete",
    title: "Processing completed",
    status: "pending",
    detail: "Results are ready for review",
  },
];

const Page = () => {
  const [phase, setPhase] = useState<"splash" | "auth" | "workspace">("splash");
  const [authView, setAuthView] = useState<AuthView>("login");
  const [pageView, setPageView] = useState<PageView>("process");
  const [userName, setUserName] = useState<string>("");
  const [authError, setAuthError] = useState<string>("");
  const [authLoading, setAuthLoading] = useState(false);

  const [note, setNote] = useState("");
  const [days, setDays] = useState(1);
  const [addons, setAddons] = useState<string[]>([]);
  const [processState, setProcessState] = useState<ProcessStatus>("idle");
  const [processError, setProcessError] = useState<string>("");
  const [claimResult, setClaimResult] = useState<ClaimResponse | null>(null);
  const [stages, setStages] = useState<Stage[]>(stageTemplates);
  const [logs, setLogs] = useState<Array<{ time: string; message: string }>>(
    [],
  );
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<
    "idle" | "running" | "success" | "failed"
  >("idle");
  const [exportMessage, setExportMessage] = useState<string>("");

  useEffect(() => {
    const savedUser = window.localStorage.getItem("curameds-user");
    if (savedUser) {
      setUserName(savedUser);
      setPhase("workspace");
    } else {
      const splashTimer = window.setTimeout(() => setPhase("auth"), 620);
      return () => window.clearTimeout(splashTimer);
    }
  }, []);

  useEffect(() => {
    if (phase === "workspace") {
      setPageView("process");
    }
  }, [phase]);

  const teamGreeting = useMemo(() => {
    if (!userName) return "Guest clinician";
    return userName.includes(" ") ? userName.split(" ")[0] : userName;
  }, [userName]);

  const setStageStatus = (id: string, status: StageStatus) => {
    setStages((current) =>
      current.map((stage) => (stage.id === id ? { ...stage, status } : stage)),
    );
  };

  const addLog = (message: string) => {
    setLogs((current) => [
      {
        time: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
        message,
      },
      ...current,
    ]);
  };

  const resetProcess = () => {
    setProcessState("idle");
    setProcessError("");
    setClaimResult(null);
    setStages(stageTemplates);
    setLogs([]);
    setExportStatus("idle");
    setExportMessage("");
  };

  const validateEmail = (value: string) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

  const handleAuthSubmit = (form: {
    name?: string;
    email: string;
    password: string;
    confirm?: string;
  }) => {
    setAuthError("");
    if (!validateEmail(form.email)) {
      setAuthError("Enter a valid work email.");
      return;
    }
    if (form.password.length < 8) {
      setAuthError("Password must be at least 8 characters.");
      return;
    }
    if (authView === "signup" && form.password !== form.confirm) {
      setAuthError("Passwords do not match.");
      return;
    }

    setAuthLoading(true);
    window.setTimeout(() => {
      setAuthLoading(false);
      setUserName(form.name || form.email.split("@")[0]);
      window.localStorage.setItem(
        "curameds-user",
        form.name || form.email.split("@")[0],
      );
      setPhase("workspace");
      addLog("Signed in successfully");
    }, 700);
  };

  const handleLogout = () => {
    window.localStorage.removeItem("curameds-user");
    setUserName("");
    setPhase("auth");
    setAuthView("login");
    resetProcess();
  };

  const updateAddon = (addon: string) => {
    setAddons((current) =>
      current.includes(addon)
        ? current.filter((item) => item !== addon)
        : [...current, addon],
    );
  };

  const formatCurrency = (value: number) =>
    new Intl.NumberFormat("en-NG", {
      style: "currency",
      currency: "NGN",
      maximumFractionDigits: 0,
    }).format(value);

  const handleProcess = async () => {
    setProcessError("");
    setExportMessage("");
    const trimmed = note.trim();
    if (!trimmed) {
      setProcessError("Enter the clinical note before processing.");
      return;
    }
    if (days < 1) {
      setProcessError("Days on admission must be at least 1.");
      return;
    }

    resetProcess();
    setProcessState("running");
    setSelectedStageId("analysis");
    setStageStatus("input", "completed");
    setStageStatus("analysis", "active");
    addLog("Started claim processing");
    addLog("Validating clinical note and inputs");

    try {
      addLog("Sending data to backend /process endpoint");
      setStageStatus("analysis", "active");

      const payload = await processClaim({ note: trimmed, days, addons, user_id: "demo_clinician", });
      setClaimResult(payload);
      addLog("Backend processing completed successfully");
      addLog(`Claim created: ${payload.claim_id}`);
      addLog(`ICD results: ${payload.icd_codes.length} suggestion(s)`);
      addLog(`Medication findings: ${payload.meds.length} extracted`);
      addLog(`Audit flags: ${payload.nhia_audit.flags.length}`);

      setStageStatus("analysis", "completed");
      setStageStatus("diagnosis", "completed");
      setStageStatus(
        "mapping",
        payload.icd_codes.length ? "completed" : "warning",
      );
      setStageStatus(
        "medications",
        payload.meds.length ? "completed" : "warning",
      );
      setStageStatus(
        "audit",
        payload.nhia_audit.flags.length ? "warning" : "completed",
      );
      setStageStatus("tariff", "completed");
      setStageStatus("claim", "completed");
      setStageStatus("complete", "completed");
      setProcessState("success");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to complete processing.";
      setProcessError(message);
      setProcessState("failed");
      setStageStatus("analysis", "failed");
      setStageStatus("complete", "failed");
      addLog(`Processing failed: ${message}`);
    }
  };

  const handleExport = async () => {
    setExportStatus("running");
    setExportMessage("Preparing export batch...");
    setProcessError("");
    try {
      const response = await exportClaims();
      const contentType = response.headers.get("Content-Type") || "";
      if (contentType.includes("application/json")) {
        const payload = await response.json();
        throw new Error(payload.error || "Export failed");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "CuraMeds_NHIA_Export.xlsx";
      anchor.click();
      URL.revokeObjectURL(url);
      setExportStatus("success");
      setExportMessage("Export downloaded successfully.");
      addLog("Export batch download completed");
    } catch (error) {
      setExportStatus("failed");
      setExportMessage(
        error instanceof Error ? error.message : "Export failed.",
      );
      addLog(
        `Export failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  };

  const isExportPage = pageView === "export";
  const hasAuditWarnings = claimResult?.nhia_audit.flags.length ? true : false;

  if (phase === "splash") {
    return (
      <main className="app-shell splash-shell" aria-live="polite">
        <div className="splash-card">
          <img src="/logo.png" alt="CuraMeds logo" className="splash-logo" />
          <p className="splash-copy">
            Clinical claims intelligence for NHIA and G-DRG audits.
          </p>
          <div className="splash-loader" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </div>
      </main>
    );
  }

  if (phase === "auth") {
    return (
      <main className="auth-shell">
        <section className="auth-panel" aria-labelledby="auth-heading">
          <div className="brand-strip">
            <img src="/logo.png" alt="CuraMeds logo" className="brand-logo" />
            <div>
              <div className="brand-mark">CuraMeds</div>
              <div className="brand-tag">NHIA Audit Workspace</div>
            </div>
          </div>
          <div className="auth-copy">
            <p className="eyebrow">Clinical workflow</p>
            <h1 id="auth-heading">
              Sign in to monitor claims, check audit rules, and review G-DRG
              results.
            </h1>
            <p>
              Secure workspace for note processing, ICD mapping, medication
              review, and export-ready claim summaries.
            </p>
          </div>

          <form
            className="auth-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              if (authView === "login") {
                handleAuthSubmit({
                  email: String(form.get("email") || ""),
                  password: String(form.get("password") || ""),
                });
              } else {
                handleAuthSubmit({
                  name: String(form.get("name") || ""),
                  email: String(form.get("email") || ""),
                  password: String(form.get("password") || ""),
                  confirm: String(form.get("confirm") || ""),
                });
              }
            }}
          >
            {authView === "signup" && (
              <label className="field">
                <span className="field-label">Full name</span>
                <input
                  name="name"
                  type="text"
                  autoComplete="name"
                  placeholder="Dr. Amina Yusuf"
                  required
                />
              </label>
            )}
            <label className="field">
              <span className="field-label">Work email</span>
              <input
                name="email"
                type="email"
                autoComplete="email"
                placeholder="amina.yusuf@clinic.ng"
                required
              />
            </label>
            <label className="field">
              <span className="field-label">Password</span>
              <input
                name="password"
                type="password"
                autoComplete={
                  authView === "signup" ? "new-password" : "current-password"
                }
                placeholder="Enter your password"
                required
                minLength={8}
              />
            </label>
            {authView === "signup" && (
              <label className="field">
                <span className="field-label">Confirm password</span>
                <input
                  name="confirm"
                  type="password"
                  autoComplete="new-password"
                  placeholder="Confirm password"
                  required
                  minLength={8}
                />
              </label>
            )}
            {authError && (
              <div className="form-error" role="alert">
                {authError}
              </div>
            )}
            <button
              type="submit"
              className="button button-primary"
              disabled={authLoading}
            >
              {authLoading
                ? "Verifying credentials…"
                : authView === "login"
                  ? "Sign in"
                  : "Create account"}
            </button>
          </form>

          <div className="auth-footer">
            {authView === "login" ? (
              <p>
                New to CuraMeds?{" "}
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => setAuthView("signup")}
                >
                  Create account
                </button>
              </p>
            ) : (
              <p>
                Already registered?{" "}
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => setAuthView("login")}
                >
                  Sign in
                </button>
              </p>
            )}
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-nav-compact">
          <img src="/logo.png" alt="CuraMeds logo" className="brand-logo-compact" />
          <div className="brand-text-compact">
            <div className="brand-mark-compact">CuraMeds</div>
            <small className="brand-subtitle-compact">NHIA Audit</small>
          </div>
        </div>
        <nav className="site-nav" aria-label="Primary navigation">
          <button
            className={pageView === "process" ? "nav-link active" : "nav-link"}
            onClick={() => setPageView("process")}
          >
            Claim process
          </button>
          <button
            className={pageView === "export" ? "nav-link active" : "nav-link"}
            onClick={() => setPageView("export")}
          >
            Export data
          </button>
        </nav>
        <div className="user-strip">
          <div>
            <span className="user-label">Signed in as</span>
            <strong>{teamGreeting}</strong>
          </div>
          <button className="button button-ghost" onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </header>

      {isExportPage ? (
        <section className="panel-card export-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Export workspace</p>
              <h2>Download the latest NHIA batch</h2>
            </div>
            <span
              className={
                exportStatus === "success"
                  ? "status-pill status-success"
                  : exportStatus === "failed"
                    ? "status-pill status-warning"
                    : "status-pill status-muted"
              }
            >
              {exportStatus === "running"
                ? "Exporting"
                : exportStatus === "failed"
                  ? "Failed"
                  : "Ready to export"}
            </span>
          </div>
          <div className="panel-content">
            <p className="hero-copy">
              Request a backend-generated NHIA export file from the current
              claim repository.
            </p>
            <button
              className="button button-teal"
              onClick={handleExport}
              disabled={exportStatus === "running"}
            >
              {exportStatus === "running"
                ? "Exporting…"
                : "Download NHIA export"}
            </button>
            <p
              className={exportStatus === "failed" ? "note note-error" : "note"}
            >
              {exportMessage ||
                "Export uses the backend export endpoint and returns an Excel batch."}
            </p>
          </div>
        </section>
      ) : (
        <>
          <section className="hero-panel">
            <div className="hero-intro">
              <p className="eyebrow">Clinical audit workflow</p>
              <h1>
                Process clinical notes into NHIA-ready claims with clear audit
                insight.
              </h1>
              <p className="hero-copy">
                Review ICD mapping, formulary checks, audit findings, and tariff
                calculation from one clinical workspace.
              </p>
            </div>
            <div className="hero-metric-card" aria-hidden="true">
              <div className="metric-chip">Powered by NHIA + G-DRG</div>
              <div className="metric-value">
                {claimResult
                  ? formatCurrency(claimResult.gdrg.calculated_amount)
                  : "₦0"}
              </div>
              <p className="metric-label">Latest claim estimate</p>
            </div>
          </section>

          <div className="workspace-grid">
            <section className="panel-card">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Note intake</p>
                  <h2>Clinical note input</h2>
                </div>
                <span className="status-pill status-primary">Ready</span>
              </div>
              <div className="panel-content">
                <label className="field full">
                  <span className="field-label">Clinical note</span>
                  <textarea
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="Enter the clinical note text, e.g. 28F, fever 3 days, RDT positive. Rx: AL, Paracetamol"
                    rows={7}
                    aria-invalid={!!processError}
                  />
                </label>

                <div className="form-row">
                  <label className="field compact">
                    <span className="field-label">Admission days</span>
                    <input
                      type="number"
                      min={1}
                      value={days}
                      onChange={(event) => setDays(Number(event.target.value))}
                    />
                  </label>
                  <div className="field compact">
                    <span className="field-label">Add-ons</span>
                    <div
                      className="chip-group"
                      role="group"
                      aria-label="Select add-ons"
                    >
                      {["blood_transfusion", "icu", "dialysis", "surgery"].map(
                        (addon) => (
                          <button
                            key={addon}
                            type="button"
                            className={
                              addons.includes(addon)
                                ? "chip chip-selected"
                                : "chip"
                            }
                            onClick={() => updateAddon(addon)}
                          >
                            {addon.replace("_", " ")}
                          </button>
                        ),
                      )}
                    </div>
                  </div>
                </div>
                {processError && (
                  <div className="form-error" role="alert">
                    {processError}
                  </div>
                )}
                <div className="action-row">
                  <button
                    className="button button-primary"
                    onClick={handleProcess}
                    disabled={processState === "running"}
                  >
                    {processState === "running"
                      ? "Processing…"
                      : "Process claim note"}
                  </button>
                  <button
                    className="button button-secondary"
                    onClick={resetProcess}
                    type="button"
                  >
                    Reset workspace
                  </button>
                </div>
              </div>
            </section>

            <aside className="panel-card side-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Live processing</p>
                  <h2>Last activity</h2>
                </div>
              </div>
              <div className="panel-content">
                <div className="stat-grid">
                  <div className="stat-card">
                    <span className="stat-label">Status</span>
                    <strong>
                      {processState === "idle"
                        ? "Awaiting notes"
                        : processState === "running"
                          ? "Running"
                          : processState === "success"
                            ? "Complete"
                            : "Failed"}
                    </strong>
                  </div>
                  <div className="stat-card">
                    <span className="stat-label">Audit flags</span>
                    <strong>{claimResult?.nhia_audit.flags.length ?? 0}</strong>
                  </div>
                  <div className="stat-card">
                    <span className="stat-label">Medications found</span>
                    <strong>{claimResult?.meds.length ?? 0}</strong>
                  </div>
                  <div className="stat-card">
                    <span className="stat-label">ICD suggestions</span>
                    <strong>{claimResult?.icd_codes.length ?? 0}</strong>
                  </div>
                </div>
                <div className="panel-divider" />
                <button
                  className="button button-teal"
                  onClick={handleExport}
                  disabled={exportStatus === "running"}
                >
                  {exportStatus === "running"
                    ? "Exporting…"
                    : "Download NHIA export"}
                </button>
                <p
                  className={
                    exportStatus === "failed" ? "note note-error" : "note"
                  }
                >
                  {exportMessage || "Export the latest claim batch into Excel."}
                </p>
              </div>
            </aside>
          </div>

          {processState !== "idle" && (
            <section className="processing-monitor" aria-label="Processing monitor">
              <div className="processing-monitor-header">
                <div>
                  <p className="eyebrow">Processing monitor</p>
                  <h2>
                    {processState === "running"
                      ? "Claim processing in progress"
                      : processState === "success"
                        ? "Claim processing completed"
                        : "Claim processing stopped"}
                  </h2>
                </div>
                <span
                  className={`monitor-status monitor-status-${processState}`}
                  aria-live="polite"
                >
                  {processState === "running"
                    ? "Live"
                    : processState === "success"
                      ? "Complete"
                      : "Attention"}
                </span>
              </div>

              <div className="processing-monitor-grid">
                <section className="monitor-panel timeline-panel">
                  <div className="monitor-panel-header">
                    <div>
                      <p className="eyebrow">Workflow</p>
                      <h3>Processing timeline</h3>
                    </div>
                    <span className="monitor-count">{stages.length} stages</span>
                  </div>

                  <div className="timeline-track">
                    <div
                      className="timeline-list"
                      role="list"
                      aria-label="Claim processing stages"
                    >
                      {stages.map((stage, index) => {
                        const selected = selectedStageId === stage.id;
                        const statusLabel =
                          stage.status === "active"
                            ? "In progress"
                            : stage.status === "completed"
                              ? "Completed"
                              : stage.status === "warning"
                                ? "Review"
                                : stage.status === "failed"
                                  ? "Failed"
                                  : "Pending";

                        return (
                          <div
                            key={stage.id}
                            className={`timeline-node status-${stage.status}${selected ? " is-selected" : ""}`}
                            role="listitem"
                          >
                            <div className="timeline-marker-container">
                              <div className="timeline-marker" aria-hidden="true">
                                {stage.status === "completed" && (
                                  <svg
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2.5"
                                  >
                                    <polyline points="20 6 9 17 4 12" />
                                  </svg>
                                )}
                                {stage.status === "active" && (
                                  <div className="timeline-spinner" />
                                )}
                                {stage.status === "warning" && (
                                  <svg viewBox="0 0 24 24" fill="currentColor">
                                    <circle cx="12" cy="12" r="10" />
                                    <text
                                      x="12"
                                      y="16"
                                      textAnchor="middle"
                                      fontSize="14"
                                      fill="white"
                                    >
                                      !
                                    </text>
                                  </svg>
                                )}
                                {stage.status === "failed" && (
                                  <svg
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2.5"
                                  >
                                    <line x1="18" y1="6" x2="6" y2="18" />
                                    <line x1="6" y1="6" x2="18" y2="18" />
                                  </svg>
                                )}
                              </div>
                              {index < stages.length - 1 && (
                                <div className="timeline-line" />
                              )}
                            </div>

                            <button
                              type="button"
                              className="timeline-card"
                              onClick={() =>
                                setSelectedStageId(selected ? null : stage.id)
                              }
                              aria-expanded={selected}
                              aria-label={`${stage.title}. ${statusLabel}. Show details`}
                            >
                              <span className="timeline-card-copy">
                                <span className="timeline-card-topline">
                                  <span className="timeline-title">
                                    {stage.title}
                                  </span>
                                  <span
                                    className={`timeline-status status-text-${stage.status}`}
                                  >
                                    {statusLabel}
                                  </span>
                                </span>
                                <span className="timeline-detail">
                                  {stage.detail}
                                </span>
                                {selected && (
                                  <span className="timeline-expanded-detail">
                                    {stage.detail}. Technical processing
                                    information is available in the live log.
                                  </span>
                                )}
                              </span>

                              <span
                                className={`timeline-chevron${selected ? " is-open" : ""}`}
                                aria-hidden="true"
                              >
                                <svg
                                  viewBox="0 0 20 20"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.8"
                                >
                                  <path d="m5 7.5 5 5 5-5" />
                                </svg>
                              </span>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </section>

                <section className="monitor-panel log-panel">
                  <div className="monitor-panel-header">
                    <div>
                      <p className="eyebrow">Technical trace</p>
                      <h3>
                        {selectedStageId
                          ? stages.find(
                              (stage) => stage.id === selectedStageId,
                            )?.title || "Processing log"
                          : "Processing log"}
                      </h3>
                    </div>
                    <span className="monitor-live-dot" aria-label="Live log" />
                  </div>

                  <div className="panel-content log-list" aria-live="polite">
                    {logs.length ? (
                      logs.map((entry, index) => (
                        <div
                          key={`${entry.time}-${index}`}
                          className="log-entry"
                        >
                          <span className="log-time">{entry.time}</span>
                          <p>{entry.message}</p>
                        </div>
                      ))
                    ) : (
                      <p className="note">
                        Log data will appear here as processing begins.
                      </p>
                    )}
                  </div>
                </section>
              </div>
            </section>
          )}

          <section className="results-grid">
            <div className="panel-card results-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Audit results</p>
                  <h2>Review extracted claim data</h2>
                </div>
                <span
                  className={
                    claimResult
                      ? "status-pill status-success"
                      : "status-pill status-muted"
                  }
                >
                  {claimResult ? "Ready to review" : "No recent result"}
                </span>
              </div>

              {claimResult ? (
                <div className="results-body">
                  <div className="summary-grid">
                    <div className="summary-card">
                      <span className="summary-label">Primary diagnosis</span>
                      <strong>{claimResult.diagnosis}</strong>
                    </div>
                    <div className="summary-card">
                      <span className="summary-label">Primary ICD code</span>
                      <strong>{claimResult.icd_codes[0]?.code ?? "R69"}</strong>
                    </div>
                    <div className="summary-card">
                      <span className="summary-label">Tariff estimate</span>
                      <strong>
                        {formatCurrency(claimResult.gdrg.calculated_amount)}
                      </strong>
                    </div>
                    <div className="summary-card">
                      <span className="summary-label">Audit risk</span>
                      <strong>
                        {claimResult.nhia_audit.flags.length
                          ? "Action needed"
                          : "No critical flags"}
                      </strong>
                    </div>
                  </div>

                  <div className="detail-grid">
                    <section className="detail-card">
                      <div className="detail-header">
                        <h3>ICD mapping</h3>
                        <span className="badge badge-muted">
                          {claimResult.icd_codes.length} suggestions
                        </span>
                      </div>
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>Code</th>
                              <th>Description</th>
                              <th>Keyword match</th>
                            </tr>
                          </thead>
                          <tbody>
                            {claimResult.icd_codes.map((item) => (
                              <tr key={item.code}>
                                <td>{item.code}</td>
                                <td>{item.description}</td>
                                <td>{item.keyword}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>

                    <section className="detail-card">
                      <div className="detail-header">
                        <h3>Medication findings</h3>
                        <span className="badge badge-info">
                          {claimResult.meds.length} identified
                        </span>
                      </div>
                      <div className="pill-row">
                        {claimResult.meds.length ? (
                          claimResult.meds.map((med) => (
                            <span key={med} className="pill">
                              {med}
                            </span>
                          ))
                        ) : (
                          <p className="note">
                            No medications were extracted from the note.
                          </p>
                        )}
                      </div>
                      <div className="pill-row">
                        {claimResult.safety.off_formulary.length ? (
                          claimResult.safety.off_formulary.map((med) => (
                            <span key={med} className="pill pill-warning">
                              {med}
                            </span>
                          ))
                        ) : (
                          <p className="note">
                            All identified medicines are on formulary.
                          </p>
                        )}
                      </div>
                    </section>
                  </div>

                  <div className="detail-grid">
                    <section className="detail-card">
                      <div className="detail-header">
                        <h3>Audit flags</h3>
                        <span
                          className={`badge ${hasAuditWarnings ? "badge-warning" : "badge-success"}`}
                        >
                          {hasAuditWarnings
                            ? "Review required"
                            : "No critical findings"}
                        </span>
                      </div>
                      {claimResult.nhia_audit.flags.length ? (
                        <div className="flag-list">
                          {claimResult.nhia_audit.flags.map((flag, index) => (
                            <article
                              key={`${flag.issue}-${index}`}
                              className="flag-row"
                            >
                              <div>
                                <strong>{flag.issue}</strong>
                                <p>{flag.fix}</p>
                              </div>
                              <span
                                className={`severity severity-${flag.level.toLowerCase()}`}
                              >
                                {flag.level}
                              </span>
                            </article>
                          ))}
                        </div>
                      ) : (
                        <p className="note">
                          Audit checks did not identify any red or yellow
                          issues.
                        </p>
                      )}
                    </section>

                    <section className="detail-card">
                      <div className="detail-header">
                        <h3>Tariff & claim</h3>
                        <span className="badge badge-teal">G-DRG</span>
                      </div>
                      <dl className="definition-list">
                        <div>
                          <dt>DRG code</dt>
                          <dd>{claimResult.gdrg.gdrg_code}</dd>
                        </div>
                        <div>
                          <dt>Description</dt>
                          <dd>{claimResult.gdrg.gdrg_name}</dd>
                        </div>
                        <div>
                          <dt>Final amount</dt>
                          <dd>
                            {formatCurrency(claimResult.gdrg.calculated_amount)}
                          </dd>
                        </div>
                        <div>
                          <dt>Estimated payout</dt>
                          <dd>{claimResult.nhia_audit.estimated_payout}</dd>
                        </div>
                      </dl>
                      <pre className="breakdown-block">
                        {claimResult.gdrg.breakdown}
                      </pre>
                    </section>
                  </div>

                  <section className="detail-card full-width">
                    <div className="detail-header">
                      <h3>Discharge summary</h3>
                    </div>
                    <pre className="discharge-block">
                      {claimResult.discharge}
                    </pre>
                  </section>
                </div>
              ) : (
                <div className="empty-state">
                  <p className="empty-heading">No claim processed yet</p>
                  <p className="note">
                    Start by entering a clinical note and processing it to
                    review audit findings and tariff calculations.
                  </p>
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </main>
  );
};

export default Page;