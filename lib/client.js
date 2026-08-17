window.__ModuleLoader__.load({ id: "dsh-action-outbox", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// client.js
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  exactCommitPrompt: () => exactCommitPrompt,
  inject: () => inject,
  safeDemoPrompt: () => safeDemoPrompt,
  splitOutboxes: () => splitOutboxes
});
module.exports = __toCommonJS(client_exports);
var import_react = __toESM(require("react"), 1);
var h = import_react.default.createElement;
var API = "/plugins/action-outbox/inbox";
var HIDDEN_HISTORY_PHASES = /* @__PURE__ */ new Set(["expired"]);
function splitOutboxes(outboxes) {
  const active = [];
  const history = [];
  for (const outbox of outboxes) {
    if (HIDDEN_HISTORY_PHASES.has(outbox.phase)) history.push(outbox);
    else active.push(outbox);
  }
  return { active, history };
}
function safeDemoPrompt(now = /* @__PURE__ */ new Date()) {
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  const path = `/private/tmp/dsh-action-outbox-demo-${stamp}.txt`;
  return [
    "Run a safe Action Outbox experience test with no network access.",
    'Call action_outbox_begin with label "Safe Inbox demo".',
    "Choose the currently available local Bash or Shell tool as the target, but do not call it directly.",
    `Stage exactly one no-clobber action that writes "Hello from Action Outbox" to ${path}; if the file exists, fail safely and never overwrite it.`,
    "Call action_outbox_review, then stop and report the exact digest and approval_nonce.",
    "Do not call action_outbox_commit, do not read workspace files, and do not perform any other side effect."
  ].join(" ");
}
function canonicalJson(value) {
  const sort = (input) => {
    if (Array.isArray(input)) return input.map(sort);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(Object.keys(input).sort().map((key) => [key, sort(input[key])]));
    }
    return input;
  };
  return JSON.stringify(sort(value));
}
function reviewEnvelope(batch) {
  return {
    outbox_id: batch.outbox_id,
    owner: batch.owner,
    phase: batch.phase,
    digest: batch.digest,
    approval_nonce: batch.approval_nonce,
    actions: batch.actions.map((action) => ({
      id: action.id,
      tool: action.tool,
      tool_source: action.tool_source,
      tool_fingerprint: action.tool_fingerprint,
      arguments: action.arguments,
      argument_bytes: action.argument_bytes,
      action_digest: action.action_digest,
      ...action.summary === void 0 ? {} : { summary: action.summary }
    }))
  };
}
function exactCommitPrompt(batch) {
  if (!batch.reviewed || !batch.approval_nonce) return "";
  return [
    "Commit the batch currently reviewed in Batch Review Inbox.",
    "Call action_outbox_commit exactly once with",
    `expected_digest "${batch.digest}" and`,
    `approval_nonce "${batch.approval_nonce}".`,
    "These are the current Inbox values; do not reuse any older digest or nonce from chat history.",
    "Do not stage, replace, or call the target tool directly."
  ].join(" ");
}
var panel = {
  open: false,
  snapshot: { loading: false, outboxes: [], error: "" },
  listeners: /* @__PURE__ */ new Set(),
  notify() {
    for (const listener of this.listeners) listener();
  },
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  },
  getSnapshot() {
    return this.snapshot;
  },
  setOpen(open) {
    this.open = open;
    this.notify();
  },
  isOpen() {
    return this.open;
  },
  async refresh() {
    this.snapshot = { ...this.snapshot, loading: true, error: "" };
    this.notify();
    try {
      const response = await fetch(API, { cache: "no-store", credentials: "same-origin" });
      const value = await response.json();
      if (!response.ok || value.ok !== true) throw new Error(value.message ?? "Unable to load outboxes");
      this.snapshot = { loading: false, outboxes: value.outboxes, error: "" };
    } catch (error) {
      this.snapshot = { ...this.snapshot, loading: false, error: String(error.message ?? error) };
    }
    this.notify();
  },
  async post(action, body) {
    const response = await fetch(`${API}/${action}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const value = await response.json();
    if (!response.ok || value.ok !== true) throw new Error(value.message ?? `Unable to ${action}`);
    await this.refresh();
    return value;
  }
};
var colors = {
  bg: "var(--dsw-alias-bg-layer-1)",
  bg2: "var(--dsw-alias-bg-layer-2)",
  text: "var(--dsw-alias-label-primary)",
  dim: "var(--dsw-alias-label-secondary)",
  border: "var(--dsw-alias-border-l2)",
  hover: "var(--dsw-alias-interactive-bg-hover)",
  accent: "var(--dsw-alias-brand-primary)",
  danger: "var(--dsw-alias-status-error)"
};
var buttonStyle = {
  minHeight: 32,
  padding: "6px 12px",
  border: `1px solid ${colors.border}`,
  borderRadius: 9,
  color: colors.text,
  background: "transparent",
  cursor: "pointer",
  font: "inherit"
};
var primaryButton = {
  ...buttonStyle,
  background: colors.accent,
  color: "var(--dsw-alias-label-on-primary, #fff)"
};
function usePanelSnapshot() {
  return (0, import_react.useSyncExternalStore)(
    (listener) => panel.subscribe(listener),
    () => panel.getSnapshot()
  );
}
function usePanelOpen() {
  return (0, import_react.useSyncExternalStore)(
    (listener) => panel.subscribe(listener),
    () => panel.isOpen()
  );
}
function InboxButton({ wide }) {
  const snapshot = usePanelSnapshot();
  (0, import_react.useEffect)(() => {
    void panel.refresh();
    const interval = window.setInterval(() => {
      void panel.refresh();
    }, 5e3);
    return () => window.clearInterval(interval);
  }, []);
  const count = splitOutboxes(snapshot.outboxes).active.length;
  return h(
    "button",
    {
      type: "button",
      onClick: () => panel.setOpen(true),
      title: "Batch Review Inbox",
      "aria-label": `Batch Review Inbox, ${count} batch${count === 1 ? "" : "es"}`,
      style: {
        ...buttonStyle,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 7,
        width: wide ? "auto" : 36,
        padding: wide ? "6px 10px" : 6
      }
    },
    h("span", { "aria-hidden": true }, "\u25A3"),
    wide ? h("span", null, "Outbox") : null,
    count > 0 ? h("span", {
      style: {
        minWidth: 18,
        height: 18,
        padding: "0 5px",
        borderRadius: 9,
        background: colors.accent,
        color: "var(--dsw-alias-label-on-primary, #fff)",
        fontSize: 11,
        lineHeight: "18px"
      }
    }, String(count)) : null
  );
}
function StatusPill({ phase }) {
  return h("span", {
    style: {
      display: "inline-flex",
      padding: "2px 7px",
      border: `1px solid ${colors.border}`,
      borderRadius: 999,
      color: phase === "recovery_required" ? colors.danger : colors.dim,
      fontSize: 11,
      lineHeight: "16px"
    }
  }, phase);
}
function ActionEditor({ batch, action, onError }) {
  const editable = batch.phase === "open" || batch.phase === "needs_reapproval";
  const [tool, setTool] = (0, import_react.useState)(action.tool);
  const [summary, setSummary] = (0, import_react.useState)(action.summary ?? "");
  const [argumentsText, setArgumentsText] = (0, import_react.useState)(JSON.stringify(action.arguments, null, 2));
  const [saving, setSaving] = (0, import_react.useState)(false);
  const save = async () => {
    setSaving(true);
    onError("");
    try {
      const args = JSON.parse(argumentsText);
      await panel.post("replace", {
        owner_id: batch.owner_id,
        action_id: action.id,
        expected_digest: batch.digest,
        approval_nonce: batch.approval_nonce,
        tool,
        arguments: args,
        summary
      });
    } catch (error) {
      onError(String(error.message ?? error));
    } finally {
      setSaving(false);
    }
  };
  return h(
    "section",
    {
      style: {
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        padding: 14,
        background: colors.bg2
      }
    },
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10 } },
      h("strong", null, action.id),
      h(StatusPill, { phase: action.status }),
      h("span", { style: { color: colors.dim, fontSize: 12, marginLeft: "auto" } }, `${action.argument_bytes} bytes`)
    ),
    h(
      "label",
      { style: { display: "grid", gap: 5, marginBottom: 10, fontSize: 12, color: colors.dim } },
      "Tool",
      h("input", {
        value: tool,
        disabled: !editable,
        onChange: (event) => setTool(event.target.value),
        style: { ...buttonStyle, cursor: editable ? "text" : "default", color: colors.text, background: colors.bg }
      })
    ),
    h(
      "label",
      { style: { display: "grid", gap: 5, marginBottom: 10, fontSize: 12, color: colors.dim } },
      "Summary",
      h("input", {
        value: summary,
        disabled: !editable,
        onChange: (event) => setSummary(event.target.value),
        style: { ...buttonStyle, cursor: editable ? "text" : "default", color: colors.text, background: colors.bg }
      })
    ),
    h(
      "label",
      { style: { display: "grid", gap: 5, fontSize: 12, color: colors.dim } },
      "Complete canonical arguments",
      h("textarea", {
        value: argumentsText,
        readOnly: !editable,
        spellCheck: false,
        rows: Math.min(18, Math.max(5, argumentsText.split("\n").length + 1)),
        onChange: (event) => setArgumentsText(event.target.value),
        style: {
          width: "100%",
          boxSizing: "border-box",
          resize: "vertical",
          padding: 10,
          border: `1px solid ${colors.border}`,
          borderRadius: 8,
          color: colors.text,
          background: colors.bg,
          fontFamily: "var(--dsw-font-family-mono)",
          fontSize: 12,
          lineHeight: 1.5
        }
      })
    ),
    h(
      "dl",
      { style: { display: "grid", gridTemplateColumns: "110px minmax(0,1fr)", gap: "4px 8px", margin: "10px 0", fontSize: 11 } },
      h("dt", { style: { color: colors.dim } }, "Tool source"),
      h("dd", { style: { margin: 0 } }, action.tool_source),
      h("dt", { style: { color: colors.dim } }, "Tool fingerprint"),
      h("dd", { style: { margin: 0, overflowWrap: "anywhere" } }, action.tool_fingerprint ?? "unavailable"),
      h("dt", { style: { color: colors.dim } }, "Action hash"),
      h("dd", { style: { margin: 0, overflowWrap: "anywhere" } }, action.action_digest)
    ),
    editable ? h("button", {
      type: "button",
      disabled: saving,
      onClick: () => {
        void save();
      },
      style: primaryButton
    }, saving ? "Saving\u2026" : "Save edit & invalidate review") : null
  );
}
function ReviewAcknowledgement({ batch, onError }) {
  const [checked, setChecked] = (0, import_react.useState)(false);
  const [busy, setBusy] = (0, import_react.useState)(false);
  if (!batch.review_requires_full_ack || batch.review_acknowledged) return null;
  return h(
    "div",
    {
      style: {
        border: `1px solid ${colors.danger}`,
        borderRadius: 10,
        padding: 12,
        display: "grid",
        gap: 10
      }
    },
    h("strong", null, "Approval is locked because the compact preview is truncated."),
    h(
      "label",
      { style: { display: "flex", alignItems: "flex-start", gap: 8 } },
      h("input", { type: "checkbox", checked, onChange: (event) => setChecked(event.target.checked) }),
      h("span", null, "I reviewed every complete canonical argument, tool source, byte count, and hash shown below.")
    ),
    h("button", {
      type: "button",
      disabled: !checked || busy,
      onClick: () => {
        setBusy(true);
        onError("");
        void panel.post("acknowledge", {
          owner_id: batch.owner_id,
          expected_digest: batch.digest,
          approval_nonce: batch.approval_nonce
        }).catch((error) => onError(String(error.message ?? error))).finally(() => setBusy(false));
      },
      style: checked ? primaryButton : { ...buttonStyle, cursor: "not-allowed", opacity: 0.6 }
    }, busy ? "Recording\u2026" : "Acknowledge complete review")
  );
}
function BatchDetail({ batch }) {
  const [error, setError] = (0, import_react.useState)("");
  const [busy, setBusy] = (0, import_react.useState)("");
  const [commitPromptCopied, setCommitPromptCopied] = (0, import_react.useState)(false);
  const envelope = (0, import_react.useMemo)(() => canonicalJson(reviewEnvelope(batch)), [batch.digest, batch.approval_nonce]);
  const commitPrompt = (0, import_react.useMemo)(() => exactCommitPrompt(batch), [batch.digest, batch.approval_nonce, batch.reviewed]);
  const run = async (action) => {
    setBusy(action);
    setError("");
    try {
      await panel.post(action, { owner_id: batch.owner_id });
    } catch (cause) {
      setError(String(cause.message ?? cause));
    } finally {
      setBusy("");
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(envelope);
    } catch (cause) {
      setError(String(cause.message ?? cause));
    }
  };
  const copyCommitPrompt = async () => {
    try {
      await navigator.clipboard.writeText(commitPrompt);
      setCommitPromptCopied(true);
    } catch (cause) {
      setError(String(cause.message ?? cause));
    }
  };
  const download = () => {
    const blob = new Blob([`${envelope}
`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${batch.outbox_id}-canonical-review.json`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return h(
    "div",
    { style: { display: "grid", gap: 14, minWidth: 0 } },
    h(
      "div",
      { style: { display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap" } },
      h(
        "div",
        null,
        h("h2", { style: { margin: 0, fontSize: 18 } }, batch.label),
        h("div", { style: { marginTop: 5, color: colors.dim, fontSize: 12 } }, batch.outbox_id)
      ),
      h(StatusPill, { phase: batch.phase }),
      h(
        "div",
        { style: { display: "flex", gap: 7, marginLeft: "auto", flexWrap: "wrap" } },
        h("button", { type: "button", onClick: () => {
          void copy();
        }, style: buttonStyle }, "Copy full JSON"),
        h("button", { type: "button", onClick: download, style: buttonStyle }, "Download"),
        (batch.phase === "open" || batch.phase === "needs_reapproval") && !batch.reviewed ? h("button", {
          type: "button",
          disabled: busy !== "",
          onClick: () => {
            void run("review");
          },
          style: primaryButton
        }, busy === "review" ? "Reviewing\u2026" : "Run fresh review") : null,
        commitPrompt ? h("button", {
          type: "button",
          onClick: () => {
            void copyCommitPrompt();
          },
          style: primaryButton
        }, commitPromptCopied ? "Copied \u2014 paste into chat" : "Next: copy exact commit prompt") : null,
        batch.phase !== "committing" ? h("button", {
          type: "button",
          disabled: busy !== "",
          onClick: () => {
            if (window.confirm("Discard this outbox? External actions already succeeded or ambiguous cannot be undone.")) void run("discard");
          },
          style: { ...buttonStyle, color: colors.danger }
        }, busy === "discard" ? "Discarding\u2026" : "Discard") : null
      )
    ),
    batch.recovery_notice ? h("div", { style: { padding: 10, border: `1px solid ${colors.danger}`, borderRadius: 8 } }, batch.recovery_notice) : null,
    commitPrompt ? h(
      "div",
      {
        role: "status",
        style: {
          display: "grid",
          gap: 5,
          padding: 12,
          border: `1px solid ${colors.accent}`,
          borderRadius: 8,
          background: colors.bg2,
          fontSize: 12
        }
      },
      h("strong", null, "Ready for chat handoff"),
      h(
        "span",
        { style: { color: colors.dim } },
        "An Inbox-only review is not added to chat history. Use \u201CNext: copy exact commit prompt\u201D, then paste it into chat. Do not ask the agent to infer the \u201Clatest review\u201D."
      )
    ) : null,
    error ? h("div", { role: "alert", style: { color: colors.danger } }, error) : null,
    h(
      "dl",
      { style: { display: "grid", gridTemplateColumns: "120px minmax(0,1fr)", gap: "5px 10px", margin: 0, fontSize: 12 } },
      h("dt", { style: { color: colors.dim } }, "Workspace"),
      h("dd", { style: { margin: 0, overflowWrap: "anywhere" } }, batch.owner.workspace ?? "unknown"),
      h("dt", { style: { color: colors.dim } }, "Owner"),
      h("dd", { style: { margin: 0, overflowWrap: "anywhere" } }, batch.owner_id ?? "unscoped"),
      h("dt", { style: { color: colors.dim } }, "Batch digest"),
      h("dd", { style: { margin: 0, overflowWrap: "anywhere" } }, batch.digest),
      h("dt", { style: { color: colors.dim } }, "Approval nonce"),
      h("dd", { style: { margin: 0, overflowWrap: "anywhere" } }, batch.approval_nonce ?? "review required"),
      h("dt", { style: { color: colors.dim } }, "Review status"),
      h("dd", { style: { margin: 0 } }, batch.reviewed ? batch.review_acknowledged ? "reviewed and visible" : "reviewed; full acknowledgement required" : "not reviewed")
    ),
    h(ReviewAcknowledgement, { key: `${batch.digest}:${batch.approval_nonce}`, batch, onError: setError }),
    h(
      "details",
      { open: false },
      h("summary", { style: { cursor: "pointer" } }, "Canonical batch envelope"),
      h("pre", {
        style: {
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          padding: 10,
          border: `1px solid ${colors.border}`,
          borderRadius: 8,
          fontSize: 11
        }
      }, envelope)
    ),
    h(
      "div",
      { style: { display: "grid", gap: 12 } },
      ...batch.actions.map((action) => h(ActionEditor, {
        key: action.action_digest,
        batch,
        action,
        onError: setError
      }))
    )
  );
}
function InboxOverlay() {
  const open = usePanelOpen();
  const snapshot = usePanelSnapshot();
  const [selectedOwner, setSelectedOwner] = (0, import_react.useState)("");
  const [showHistory, setShowHistory] = (0, import_react.useState)(false);
  const [demoCopied, setDemoCopied] = (0, import_react.useState)(false);
  const { active, history } = splitOutboxes(snapshot.outboxes);
  const visibleOutboxes = showHistory ? [...active, ...history] : active;
  (0, import_react.useEffect)(() => {
    if (!open) return void 0;
    void panel.refresh();
    const onKey = (event) => {
      if (event.key === "Escape") panel.setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  (0, import_react.useEffect)(() => {
    if (visibleOutboxes.length === 0) setSelectedOwner("");
    else if (!visibleOutboxes.some((item) => (item.owner_id ?? item.outbox_id) === selectedOwner)) {
      setSelectedOwner(visibleOutboxes[0].owner_id ?? visibleOutboxes[0].outbox_id);
    }
  }, [visibleOutboxes, selectedOwner]);
  if (!open) return null;
  const selected = visibleOutboxes.find((item) => (item.owner_id ?? item.outbox_id) === selectedOwner) ?? visibleOutboxes[0];
  const copyDemoPrompt = async () => {
    try {
      await navigator.clipboard.writeText(safeDemoPrompt());
      setDemoCopied(true);
    } catch {
      setDemoCopied(false);
    }
  };
  return h(
    "div",
    {
      role: "dialog",
      "aria-modal": true,
      "aria-label": "Batch Review Inbox",
      style: {
        position: "fixed",
        inset: 0,
        zIndex: 1e3,
        pointerEvents: "auto",
        background: "var(--dsw-alias-mask-bg)",
        display: "grid",
        placeItems: "center",
        padding: 20
      },
      onMouseDown: (event) => {
        if (event.target === event.currentTarget) panel.setOpen(false);
      }
    },
    h(
      "div",
      {
        style: {
          width: "min(1180px, 96vw)",
          height: "min(820px, 92vh)",
          display: "grid",
          gridTemplateRows: "auto minmax(0,1fr)",
          overflow: "hidden",
          border: `1px solid ${colors.border}`,
          borderRadius: 16,
          color: colors.text,
          background: colors.bg,
          boxShadow: "var(--dsw-shadow-modal)",
          fontFamily: "var(--dsw-font-family)"
        }
      },
      h(
        "header",
        {
          style: { display: "flex", alignItems: "center", padding: "14px 18px", borderBottom: `1px solid ${colors.border}` }
        },
        h(
          "div",
          null,
          h("h1", { style: { margin: 0, fontSize: 19 } }, "Batch Review Inbox"),
          h("div", { style: { marginTop: 3, color: colors.dim, fontSize: 12 } }, "Complete arguments \xB7 editable drafts \xB7 restart-safe reapproval")
        ),
        h("button", {
          type: "button",
          onClick: () => {
            void copyDemoPrompt();
          },
          style: { ...buttonStyle, marginLeft: "auto" }
        }, demoCopied ? "Demo prompt copied" : "Copy safe demo prompt"),
        h("button", { type: "button", onClick: () => {
          void panel.refresh();
        }, style: { ...buttonStyle, marginLeft: 8 } }, snapshot.loading ? "Refreshing\u2026" : "Refresh"),
        h("button", { type: "button", onClick: () => panel.setOpen(false), "aria-label": "Close", style: { ...buttonStyle, marginLeft: 8 } }, "Close")
      ),
      h(
        "div",
        { style: { display: "grid", gridTemplateColumns: "260px minmax(0,1fr)", minHeight: 0 } },
        h(
          "nav",
          { style: { overflow: "auto", padding: 12, borderRight: `1px solid ${colors.border}` } },
          snapshot.error ? h("div", { role: "alert", style: { color: colors.danger, fontSize: 12 } }, snapshot.error) : null,
          history.length > 0 ? h("button", {
            type: "button",
            onClick: () => setShowHistory((value) => !value),
            style: { ...buttonStyle, width: "100%", marginBottom: 10 }
          }, showHistory ? "Hide expired history" : `Show expired history (${history.length})`) : null,
          visibleOutboxes.length === 0 && !snapshot.loading ? h(
            "div",
            { style: { color: colors.dim, padding: 10, lineHeight: 1.5 } },
            history.length > 0 ? "No active outboxes. Expired batches are safely hidden from the pending count." : "No active outboxes. Copy the safe demo prompt above and paste it into a new DSH chat."
          ) : visibleOutboxes.map((batch) => h(
            "button",
            {
              key: batch.owner_id ?? batch.outbox_id,
              type: "button",
              onClick: () => setSelectedOwner(batch.owner_id ?? batch.outbox_id),
              style: {
                ...buttonStyle,
                width: "100%",
                display: "grid",
                gap: 5,
                textAlign: "left",
                marginBottom: 8,
                background: selected === batch ? colors.hover : "transparent"
              }
            },
            h("strong", { style: { overflow: "hidden", textOverflow: "ellipsis" } }, batch.label),
            h("span", { style: { color: colors.dim, fontSize: 11 } }, `${batch.action_count} actions \xB7 ${batch.phase}`)
          ))
        ),
        h(
          "main",
          { style: { overflow: "auto", padding: 18 } },
          selected ? h(BatchDetail, { key: `${selected.owner_id}:${selected.digest}:${selected.approval_nonce}`, batch: selected }) : h("div", { style: { color: colors.dim } }, "Select a batch.")
        )
      )
    )
  );
}
var inject = ["slots"];
function apply(ctx) {
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
    name: "sidebar.footer.action",
    id: "action-outbox-inbox",
    order: 80,
    label: "Batch Review Inbox"
  }, InboxButton));
  ctx.slots.inject("shell.overlay", () => ctx.slots.register({
    name: "shell.overlay",
    id: "action-outbox-inbox",
    order: 80
  }, InboxOverlay));
}
return module.exports; } });
//# sourceMappingURL=client.js.map
