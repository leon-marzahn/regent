"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button, Select, Toggle } from "@/shared/components";
import { Dialog } from "@/ui/Dialog";
import { CAPACITY_META, STT_TRANSPORT_META, STT_TRANSPORTS } from "@/shared/constants/models";

const defaultCaps = () => Object.fromEntries(Object.keys(CAPACITY_META).map((key) => [key, false]));

const MODEL_TYPES = [
  { value: "llm", label: "Chat / LLM" },
  { value: "stt", label: "Speech to text (STT)" },
];

// `model` (a stored custom model record) switches the dialog to edit mode: the id
// and type are the record's key so they stay locked; name/caps/transport are editable.
// `mediaKind` (media provider pages) fixes the type to that kind.
export default function AddCustomModelModal({ isOpen, providerAlias, providerDisplayAlias, providerId, model, mediaKind, onSave, onClose }) {
  const isEdit = !!model;
  // The parent remounts the dialog (key) per open/record, so state starts from props.
  const [modelId, setModelId] = useState(() => model?.id || "");
  // Records default name to the id; only a real custom name fills the field.
  const [name, setName] = useState(() => (model?.name && model.name !== model.id ? model.name : ""));
  // The type is explicit: a chat model with Vision/Reasoning on must not turn into STT.
  const [pickedType, setModelType] = useState(() => (model ? model.kind || model.type || "llm" : "llm"));
  const modelType = mediaKind || pickedType;
  const [caps, setCaps] = useState(() => ({ ...defaultCaps(), ...(model?.caps || {}) }));
  const [testStatus, setTestStatus] = useState(null); // null | "testing" | "ok" | "error"
  const [testError, setTestError] = useState("");
  const [saving, setSaving] = useState(false);
  // Realtime dispatch marker for the transport select; "" = provider default REST.
  const [transport, setTransport] = useState(() => model?.transport || "");

  // The provider is fixed, so the field takes the bare model id. A pasted
  // "kr/model" (display alias, storage alias or provider id) is stripped.
  const stripAlias = (id) => {
    for (const p of new Set([providerDisplayAlias, providerAlias, providerId].filter(Boolean))) {
      const prefix = `${p}/`;
      if (id.startsWith(prefix)) return id.slice(prefix.length);
    }
    return id;
  };

  const handleTest = async () => {
    const cleanId = stripAlias(modelId.trim());
    if (!cleanId) return;
    setTestStatus("testing");
    setTestError("");
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `${providerAlias}/${cleanId}`, kind: modelType }),
      });
      const data = await res.json();
      setTestStatus(data.ok ? "ok" : "error");
      setTestError(data.error || "");
    } catch (err) {
      setTestStatus("error");
      setTestError(err.message);
    }
  };

  const handleSave = async () => {
    const cleanId = stripAlias(modelId.trim());
    if (!cleanId || saving) return;
    setSaving(true);
    try {
      // Caps belong to chat models; a transport only to STT records (null = provider default).
      await onSave(cleanId, modelType, modelType === "llm" ? caps : undefined, modelType === "stt" ? transport : null, name.trim());
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") handleTest();
  };

  return (
    <Dialog open={isOpen} onClose={onClose} title={isEdit ? "Edit Custom Model" : "Add Custom Model"}>
      <div className="flex flex-col gap-4">
        {!mediaKind && (
          <Select
            label="Model type"
            value={modelType}
            options={MODEL_TYPES}
            onChange={(e) => {
              setModelType(e.target.value);
              setCaps(defaultCaps());
              setTransport("");
              setTestStatus(null);
              setTestError("");
            }}
            disabled={isEdit || saving || testStatus === "testing"}
            hint={modelType === "llm"
              ? "Chat models appear in this provider's Available Models."
              : "Audio transcription models use /v1/audio/transcriptions."}
          />
        )}
        <div>
          <label htmlFor="custom-model-id" className="text-sm font-medium mb-1.5 block">Model ID</label>
          <div className="flex gap-2">
            <div className={`flex min-w-0 flex-1 items-center rounded-lg border border-border bg-background focus-within:border-primary ${isEdit ? "opacity-80" : ""}`}>
              <span className="shrink-0 select-none border-r border-border px-2.5 py-2 font-mono text-sm text-text-muted" title="Provider prefix, added automatically">
                {providerDisplayAlias}/
              </span>
              <input
                id="custom-model-id"
                type="text"
                value={modelId}
                onChange={(e) => { setModelId(e.target.value); setTestStatus(null); setTestError(""); }}
                onBlur={() => setModelId((v) => stripAlias(v.trim()))}
                onKeyDown={handleKeyDown}
                placeholder="claude-opus-4.6"
                className="min-w-0 flex-1 bg-transparent px-2.5 py-2 font-mono text-sm focus:outline-none"
                readOnly={isEdit}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
            <Button
              variant="secondary"
              icon="science"
              loading={testStatus === "testing"}
              onClick={handleTest}
              disabled={!modelId.trim() || testStatus === "testing"}
            >
              {testStatus === "testing" ? "Testing..." : "Test"}
            </Button>
          </div>
          <p className="text-xs text-text-muted mt-1 [overflow-wrap:anywhere]">
            Call it as <code className="font-mono bg-sidebar px-1 rounded">{providerDisplayAlias}/{stripAlias(modelId.trim()) || "model-id"}</code>
            {" · "}sent upstream as <code className="font-mono bg-sidebar px-1 rounded">{stripAlias(modelId.trim()) || "model-id"}</code>
          </p>
        </div>

        <div>
          <label htmlFor="custom-model-name" className="text-sm font-medium mb-1.5 block">
            Display name <span className="font-normal text-text-muted">(optional)</span>
          </label>
          <input
            id="custom-model-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            placeholder="e.g. Claude Opus 4.6"
            className="w-full min-w-0 px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
          />
          <p className="text-xs text-text-muted mt-1">Shown in model pickers and as the name in /v1/models.</p>
        </div>

        {modelType === "llm" && (
          <div>
            <label className="text-sm font-medium mb-1.5 block">Capabilities</label>
            <div className="flex flex-wrap gap-4">
              {Object.entries(CAPACITY_META).map(([key, meta]) => (
                <Toggle
                  key={key}
                  checked={!!caps[key]}
                  onChange={(v) => setCaps((prev) => ({ ...prev, [key]: v }))}
                  label={meta.label}
                  description={meta.desc}
                  size="sm"
                />
              ))}
            </div>
          </div>
        )}

        {/* The API honours a transport only on stt records: the realtime dispatch
            marker persisted with the model (whitelist: STT_TRANSPORT_META). */}
        {modelType === "stt" && (
          <Select
            label="Transport"
            value={transport}
            onChange={(e) => setTransport(e.target.value)}
            placeholder="Provider default (REST)"
            options={STT_TRANSPORTS.map((t) => ({ value: t, label: STT_TRANSPORT_META[t].label }))}
            hint="Realtime transport marker for the STT dispatcher. Empty keeps the provider's REST format."
          />
        )}

        {/* Test result */}
        {testStatus === "ok" && (
          <div className="flex items-center gap-2 text-sm text-green-600">
            <span className="material-symbols-outlined text-base">check_circle</span>
            Model is reachable
          </div>
        )}
        {testStatus === "error" && (
          <div className="flex items-start gap-2 text-sm text-red-500">
            <span className="material-symbols-outlined text-base shrink-0">cancel</span>
            <span>{testError || "Model not reachable"}</span>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <Button onClick={onClose} variant="ghost" size="sm" className="min-w-0 flex-1">Cancel</Button>
          <Button
            onClick={handleSave}
            size="sm"
            className="min-w-0 flex-1"
            disabled={!modelId.trim() || saving}
          >
            {saving ? (isEdit ? "Saving..." : "Adding...") : (isEdit ? "Save" : "Add Model")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

AddCustomModelModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  providerAlias: PropTypes.string.isRequired,
  providerDisplayAlias: PropTypes.string.isRequired,
  providerId: PropTypes.string,
  model: PropTypes.object,
  mediaKind: PropTypes.string,
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
