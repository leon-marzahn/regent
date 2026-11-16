"use client";
// oxlint-disable react/set-state-in-effect -- upstream effects/render code, untouched here; only the dialog shell changed.

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Dialog } from "@/ui/Dialog";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider, AI_PROVIDERS } from "@/shared/constants/providers";
import Select from "@/shared/components/Select";
import Toggle from "@/shared/components/Toggle";
import { TLS_IMPERSONATION_OSES, TLS_IMPERSONATION_PROFILES, normalizeTlsImpersonation } from "open-sse/config/tlsImpersonation.js";
import {
  PROVIDER_ROUTING_FIELD,
  PROVIDER_ROUTING_LIST_KEYS,
  PROVIDER_ROUTING_MAX_SLUGS,
  checkProviderSlugs,
  normalizeProviderRouting,
  parseProviderSlugs,
} from "open-sse/config/providerRouting.js";

const EMPTY_ROUTING = { only: "", order: "", ignore: "", allowFallbacks: true };

// Per-field error text, or undefined. Invalid entries block saving rather than being
// dropped, so a typo can't quietly remove a restriction.
function routingFieldError(value) {
  const { slugs, rejected } = checkProviderSlugs(value);
  if (rejected.length) return `Not a provider slug: ${rejected.join(", ")}`;
  if (slugs.length > PROVIDER_ROUTING_MAX_SLUGS) return `At most ${PROVIDER_ROUTING_MAX_SLUGS} providers`;
  return undefined;
}

function routingToForm(stored) {
  const routing = normalizeProviderRouting(stored);
  if (!routing) return EMPTY_ROUTING;
  return {
    only: (routing.only || []).join(", "),
    order: (routing.order || []).join(", "),
    ignore: (routing.ignore || []).join(", "),
    allowFallbacks: routing.allow_fallbacks !== false,
  };
}

// Empty lists are left out; allow_fallbacks is only stored when turned off (on is the default).
function routingFromForm(form) {
  const routing = {};
  for (const key of PROVIDER_ROUTING_LIST_KEYS) {
    const slugs = parseProviderSlugs(form[key]);
    if (slugs.length) routing[key] = slugs;
  }
  if (!form.allowFallbacks) routing.allow_fallbacks = false;
  return Object.keys(routing).length ? routing : null;
}

export default function EditConnectionModal({ isOpen, connection, proxyPools, onSave, onClose }) {
  const [formData, setFormData] = useState({
    name: "",
    priority: 1,
    apiKey: "",
  });
  const [azureData, setAzureData] = useState({
    azureEndpoint: "",
    apiVersion: "2024-10-01-preview",
    deployment: "",
    organization: "",
  });
  const [cloudflareData, setCloudflareData] = useState({ accountId: "" });
  const [awsData, setAwsData] = useState({ profile: "", region: "", accessKeyId: "", sessionToken: "" });
  const [clearAwsSessionToken, setClearAwsSessionToken] = useState(false);
  const [region, setRegion] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const [tls, setTls] = useState({ enabled: false, browser: "chrome", os: "macos" });
  const [routing, setRouting] = useState(EMPTY_ROUTING);

  useEffect(() => {
    if (connection) {
      setFormData({
        name: connection.name || "",
        priority: connection.priority || 1,
        apiKey: "",
      });
      // Load Azure-specific data if present
      const savedTls = normalizeTlsImpersonation(connection.providerSpecificData?.tlsImpersonation);
      setTls(savedTls ? { enabled: true, ...savedTls } : { enabled: false, browser: "chrome", os: "macos" });
      setRouting(routingToForm(connection.providerSpecificData?.[PROVIDER_ROUTING_FIELD]));
      if (connection.provider === "azure" && connection.providerSpecificData) {
        setAzureData({
          azureEndpoint: connection.providerSpecificData.azureEndpoint || "",
          apiVersion: connection.providerSpecificData.apiVersion || "2024-10-01-preview",
          deployment: connection.providerSpecificData.deployment || "",
          organization: connection.providerSpecificData.organization || "",
        });
      }
      if (connection.provider === "cloudflare-ai" && connection.providerSpecificData) {
        setCloudflareData({ accountId: connection.providerSpecificData.accountId || "" });
      }
      if (AI_PROVIDERS?.[connection.provider]?.credentialForm === "aws") {
        const psd = connection.providerSpecificData || {};
        setAwsData({
          profile: psd.profile || "",
          region: psd.region || "",
          accessKeyId: psd.accessKeyId || "",
          sessionToken: "",
        });
        setClearAwsSessionToken(false);
      }
      // Load region for providers that support it (e.g. xiaomi-tokenplan)
      const providerCfg = AI_PROVIDERS?.[connection.provider];
      if (providerCfg?.regions) {
        const savedRegion = connection.providerSpecificData?.region || providerCfg.defaultRegion || providerCfg.regions[0]?.id || "";
        setRegion(savedRegion);
      }
      setTestResult(null);
      setValidationResult(null);
    }
  }, [connection, isOpen]);

  const isOAuth = connection?.authType === "oauth";
  const isAzure = connection?.provider === "azure";
  const isCloudflareAi = connection?.provider === "cloudflare-ai";
  const usesAwsCredentialForm = AI_PROVIDERS?.[connection?.provider]?.credentialForm === "aws";
  const isCompatible = connection
    ? (isOpenAICompatibleProvider(connection.provider) || isAnthropicCompatibleProvider(connection.provider))
    : false;
  const providerRegions = connection ? (AI_PROVIDERS?.[connection.provider]?.regions || null) : null;
  const supportsRouting = !!AI_PROVIDERS?.[connection?.provider]?.providerRouting;
  const routingErrors = supportsRouting
    ? Object.fromEntries(PROVIDER_ROUTING_LIST_KEYS.map((key) => [key, routingFieldError(routing[key])]))
    : {};
  const hasRoutingError = Object.values(routingErrors).some(Boolean);

  // Build providerSpecificData for region-aware providers
  const buildRegionSpecificData = () => {
    if (providerRegions && region) return { ...((connection?.providerSpecificData) || {}), region };
    return undefined;
  };

  // The server keeps a saved session token when this password field is blank. Other empty
  // fields still clear their saved values so a profile can be switched to static keys.
  const buildAwsSpecificData = () => ({
    profile: awsData.profile.trim(),
    region: awsData.region.trim(),
    accessKeyId: awsData.accessKeyId.trim(),
    sessionToken: clearAwsSessionToken ? null : awsData.sessionToken.trim(),
  });

  const handleTest = async () => {
    if (!connection?.provider) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/providers/${connection.id}/test`, { method: "POST" });
      const data = await res.json();
      setTestResult(data.valid ? "success" : "failed");
    } catch {
      setTestResult("failed");
    } finally {
      setTesting(false);
    }
  };

  const handleValidate = async () => {
    if (!connection?.provider || !formData.apiKey) return;
    setValidating(true);
    setValidationResult(null);
    try {
      const res = await fetch("/api/providers/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: connection.provider,
          apiKey: formData.apiKey,
          ...(isAzure ? { providerSpecificData: azureData } : {}),
          ...(isCloudflareAi ? { providerSpecificData: cloudflareData } : {}),
          ...(usesAwsCredentialForm ? { providerSpecificData: buildAwsSpecificData() } : {}),
          ...(providerRegions ? { providerSpecificData: buildRegionSpecificData() } : {}),
        }),
      });
      const data = await res.json();
      setValidationResult(data.valid ? "success" : "failed");
    } catch {
      setValidationResult("failed");
    } finally {
      setValidating(false);
    }
  };

  const handleSubmit = async () => {
    if (!connection || hasRoutingError) return;
    setSaving(true);
    try {
      const updates = {
        name: formData.name,
        priority: formData.priority,
      };
      if (!isOAuth && formData.apiKey) {
        updates.apiKey = formData.apiKey;
        let isValid = validationResult === "success";
        if (!isValid) {
          try {
            setValidating(true);
            setValidationResult(null);
            const res = await fetch("/api/providers/validate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                provider: connection.provider,
                apiKey: formData.apiKey,
                ...(isAzure ? { providerSpecificData: azureData } : {}),
                ...(isCloudflareAi ? { providerSpecificData: cloudflareData } : {}),
                ...(usesAwsCredentialForm ? { providerSpecificData: buildAwsSpecificData() } : {}),
                ...(providerRegions ? { providerSpecificData: buildRegionSpecificData() } : {}),
              }),
            });
            const data = await res.json();
            isValid = !!data.valid;
            setValidationResult(isValid ? "success" : "failed");
          } catch {
            setValidationResult("failed");
          } finally {
            setValidating(false);
          }
        }
        if (isValid) {
          updates.testStatus = "active";
          updates.lastError = null;
          updates.lastErrorAt = null;
        }
      }
      
      // Add Azure-specific data if this is an Azure connection
      if (isAzure) {
        updates.providerSpecificData = {
          azureEndpoint: azureData.azureEndpoint,
          apiVersion: azureData.apiVersion,
          deployment: azureData.deployment,
          organization: azureData.organization,
        };
      }
      if (isCloudflareAi) {
        updates.providerSpecificData = { accountId: cloudflareData.accountId };
      }
      if (usesAwsCredentialForm) {
        updates.providerSpecificData = buildAwsSpecificData();
      }
      // Persist updated region for region-aware providers
      if (providerRegions && region) {
        updates.providerSpecificData = buildRegionSpecificData();
      }
      
      updates.tlsImpersonation = tls.enabled ? { browser: tls.browser, os: tls.os } : null;
      if (supportsRouting) updates[PROVIDER_ROUTING_FIELD] = routingFromForm(routing);
      await onSave(updates);
    } finally {
      setSaving(false);
    }
  };

  if (!connection) return null;

  return (
    <Dialog open={isOpen} title="Edit Connection" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Input
          label="Name"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={isOAuth ? "Account name" : "Production Key"}
        />
        {isOAuth && connection.email && (
          <div className="bg-sidebar/50 p-3 rounded-lg">
            <p className="text-sm text-text-muted mb-1">Email</p>
            <p className="font-medium">{connection.email}</p>
          </div>
        )}
        <Input
          label="Priority"
          type="number"
          value={formData.priority}
          onChange={(e) => setFormData({ ...formData, priority: Number.parseInt(e.target.value, 10) || 1 })}
        />

        {!isOAuth && (
          <>
            <div className="flex gap-2">
              <Input
                label="API Key"
                type="password"
                value={formData.apiKey}
                onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                placeholder="Enter new API key"
                hint="Leave blank to keep the current API key."
                className="flex-1"
              />
              <div className="pt-6">
                <Button onClick={handleValidate} disabled={!formData.apiKey || validating || saving} variant="secondary">
                  {validating ? "Checking..." : "Check"}
                </Button>
              </div>
            </div>
            {validationResult && (
              <Badge variant={validationResult === "success" ? "success" : "error"}>
                {validationResult === "success" ? "Valid" : "Invalid"}
              </Badge>
            )}
          </>
        )}

        {isAzure && (
          <div className="bg-sidebar/50 p-4 rounded-lg border border-accent/20">
            <h3 className="font-semibold mb-3 text-sm">Azure OpenAI Configuration</h3>
            <div className="flex flex-col gap-3">
              <Input
                label="Azure Endpoint"
                value={azureData.azureEndpoint}
                onChange={(e) => setAzureData({ ...azureData, azureEndpoint: e.target.value })}
                placeholder="https://your-resource.openai.azure.com"
                hint="Your Azure OpenAI resource endpoint URL"
              />
              <Input
                label="Deployment Name"
                value={azureData.deployment}
                onChange={(e) => setAzureData({ ...azureData, deployment: e.target.value })}
                placeholder="gpt-4"
                hint="The deployment name in your Azure resource"
              />
              <Input
                label="API Version"
                value={azureData.apiVersion}
                onChange={(e) => setAzureData({ ...azureData, apiVersion: e.target.value })}
                placeholder="2024-10-01-preview"
                hint="Azure OpenAI API version to use"
              />
              <Input
                label="Organization"
                value={azureData.organization}
                onChange={(e) => setAzureData({ ...azureData, organization: e.target.value })}
                placeholder="Organization ID"
                hint="Required for billing"
              />
            </div>
          </div>
        )}

        {usesAwsCredentialForm && (
          <div className="bg-sidebar/50 p-4 rounded-lg border border-accent/20">
            <h3 className="font-semibold mb-3 text-sm">AWS Bedrock Credentials</h3>
            <div className="flex flex-col gap-3">
              <Input
                label="AWS Profile (SSO — recommended)"
                value={awsData.profile}
                onChange={(e) => setAwsData({ ...awsData, profile: e.target.value })}
                placeholder="my-sso-profile"
                hint="Clear this to use static keys instead; a profile takes precedence."
              />
              <Input
                label="Region"
                value={awsData.region}
                onChange={(e) => setAwsData({ ...awsData, region: e.target.value })}
                placeholder="us-east-1"
              />
              <Input
                label="Access Key ID (only for static keys)"
                value={awsData.accessKeyId}
                onChange={(e) => setAwsData({ ...awsData, accessKeyId: e.target.value })}
                placeholder="AKIA..."
              />
              <Input
                label="Session Token (only for temporary ASIA… keys)"
                type="password"
                value={awsData.sessionToken}
                onChange={(e) => setAwsData({ ...awsData, sessionToken: e.target.value })}
                placeholder="FwoGZXIvYXdz..."
                hint="Leave blank to keep the saved token. Enter a new token to replace it."
                disabled={clearAwsSessionToken}
              />
              <label className="flex items-center gap-2 text-sm text-text-muted">
                <input
                  type="checkbox"
                  checked={clearAwsSessionToken}
                  onChange={(e) => {
                    setClearAwsSessionToken(e.target.checked);
                    if (e.target.checked) setAwsData({ ...awsData, sessionToken: "" });
                  }}
                />
                Remove saved session token
              </label>
            </div>
          </div>
        )}

        {providerRegions && (
          <Select
            label="Region"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            options={providerRegions.map((r) => ({ value: r.id, label: r.label }))}
          />
        )}

        {supportsRouting && (
          <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
            <div>
              <p className="text-sm font-medium">Upstream routing</p>
              <p className="text-xs text-text-muted">
                Which providers behind this aggregator may serve chat requests. Use their slugs, comma-separated, e.g. google-vertex/global. Applies to every chat request on this connection and overrides the same settings sent by a client.
              </p>
            </div>
            <Input
              label="Only these providers"
              value={routing.only}
              onChange={(e) => setRouting({ ...routing, only: e.target.value })}
              placeholder="google-vertex/global"
              error={routingErrors.only}
            />
            <Input
              label="Preferred order"
              value={routing.order}
              onChange={(e) => setRouting({ ...routing, order: e.target.value })}
              placeholder="anthropic, google-vertex"
              error={routingErrors.order}
            />
            <Input
              label="Never use"
              value={routing.ignore}
              onChange={(e) => setRouting({ ...routing, ignore: e.target.value })}
              placeholder="amazon-bedrock"
              error={routingErrors.ignore}
            />
            <Toggle
              checked={routing.allowFallbacks}
              onChange={(allowFallbacks) => setRouting({ ...routing, allowFallbacks })}
              label="Fall back to other providers"
              description="When off, a request fails instead of moving to a provider outside the list above."
            />
          </div>
        )}

        <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <Toggle
            checked={tls.enabled}
            onChange={(enabled) => setTls({ ...tls, enabled })}
            label="Browser TLS fingerprint"
            description="Send this account's requests with a browser's TLS/HTTP2 fingerprint instead of Node's. Can break the provider's terms and get the account banned. Uses normal TLS if the optional wreq-js module isn't installed."
          />
          {tls.enabled && (
            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Browser"
                value={tls.browser}
                onChange={(e) => setTls({ ...tls, browser: e.target.value })}
                options={TLS_IMPERSONATION_PROFILES}
              />
              <Select
                label="OS"
                value={tls.os}
                onChange={(e) => setTls({ ...tls, os: e.target.value })}
                options={TLS_IMPERSONATION_OSES}
              />
            </div>
          )}
        </div>

        {!isCompatible && !isAzure && !isCloudflareAi && (
          <div className="flex items-center gap-3">
            <Button onClick={handleTest} variant="secondary" disabled={testing}>
              {testing ? "Testing..." : "Test Connection"}
            </Button>
            {testResult && (
              <Badge variant={testResult === "success" ? "success" : "error"}>
                {testResult === "success" ? "Valid" : "Failed"}
              </Badge>
            )}
          </div>
        )}

        <div className="mt-2 flex justify-end gap-2">
          <Button onClick={onClose} variant="secondary">Cancel</Button>
          <Button onClick={handleSubmit} disabled={saving || hasRoutingError}>{saving ? "Saving..." : "Save"}</Button>
        </div>
      </div>
    </Dialog>
  );
}

EditConnectionModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  connection: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    email: PropTypes.string,
    priority: PropTypes.number,
    authType: PropTypes.string,
    provider: PropTypes.string,
    providerSpecificData: PropTypes.object,
  }),
  proxyPools: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
  })),
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
