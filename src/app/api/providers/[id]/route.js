import { NextResponse } from "next/server";
import {
  getProviderConnectionById,
  getProxyPoolById,
  updateProviderConnection,
  deleteProviderConnection,
} from "@/models";
import { normalizeTlsImpersonation } from "open-sse/config/tlsImpersonation.js";
import {
  PROVIDER_ROUTING_FIELD,
  checkProviderRoutingWrite,
  normalizeProviderRouting,
  supportsProviderRouting,
} from "open-sse/config/providerRouting.js";
import { toProviderConnectionResponse, usesAwsCredentialForm } from "@/lib/providerConnectionResponse";
import { MaskedUrlError, restoreMaskedUrl, restoreRedacted } from "@/lib/secretRedaction";

function normalizeProxyConfig(body = {}) {
  const hasAnyProxyField =
    Object.prototype.hasOwnProperty.call(body, "connectionProxyEnabled") ||
    Object.prototype.hasOwnProperty.call(body, "connectionProxyUrl") ||
    Object.prototype.hasOwnProperty.call(body, "connectionNoProxy");

  if (!hasAnyProxyField) return { hasAnyProxyField: false };

  const enabled = body?.connectionProxyEnabled === true;
  const url = typeof body?.connectionProxyUrl === "string" ? body.connectionProxyUrl.trim() : "";
  const noProxy = typeof body?.connectionNoProxy === "string" ? body.connectionNoProxy.trim() : "";

  if (enabled && !url) {
    return {
      hasAnyProxyField: true,
      error: "Connection proxy URL is required when connection proxy is enabled",
    };
  }

  return {
    hasAnyProxyField: true,
    connectionProxyEnabled: enabled,
    connectionProxyUrl: url,
    connectionNoProxy: noProxy,
  };
}

async function normalizeProxyPoolUpdate(proxyPoolIdInput) {
  if (proxyPoolIdInput === undefined) {
    return { hasProxyPoolField: false, proxyPoolId: null };
  }

  if (proxyPoolIdInput === null || proxyPoolIdInput === "" || proxyPoolIdInput === "__none__") {
    return { hasProxyPoolField: true, proxyPoolId: null };
  }

  const proxyPoolId = String(proxyPoolIdInput).trim();
  if (!proxyPoolId) {
    return { hasProxyPoolField: true, proxyPoolId: null };
  }

  const proxyPool = await getProxyPoolById(proxyPoolId);
  if (!proxyPool) {
    return { hasProxyPoolField: true, error: "Proxy pool not found" };
  }

  return { hasProxyPoolField: true, proxyPoolId };
}

function shouldMergeProviderSpecificData(existing, incoming, hasLegacyProxy, hasProxyPoolField) {
  return existing !== undefined || incoming !== undefined || hasLegacyProxy || hasProxyPoolField;
}

// GET /api/providers/[id] - Get single connection
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    return NextResponse.json({ connection: toProviderConnectionResponse(connection) });
  } catch (error) {
    console.log("Error fetching connection:", error);
    return NextResponse.json({ error: "Failed to fetch connection" }, { status: 500 });
  }
}

// PUT /api/providers/[id] - Update connection
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const {
      name,
      priority,
      globalPriority,
      defaultModel,
      isActive,
      apiKey,
      testStatus,
      lastError,
      lastErrorAt,
      providerSpecificData
    } = body;

    const existing = await getProviderConnectionById(id);
    if (!existing) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const proxyConfig = normalizeProxyConfig(body);
    if (proxyConfig.error) {
      return NextResponse.json({ error: proxyConfig.error }, { status: 400 });
    }

    const proxyPoolResult = await normalizeProxyPoolUpdate(body.proxyPoolId);
    if (proxyPoolResult.error) {
      return NextResponse.json({ error: proxyPoolResult.error }, { status: 400 });
    }

    const hasTlsField = Object.prototype.hasOwnProperty.call(body, "tlsImpersonation");

    // Upstream routing is the operator's policy, so a write is validated strictly: a typo
    // gets a 400 instead of being dropped, which could silently loosen or delete the policy.
    const routingWrite = checkProviderRoutingWrite(existing.provider, body);
    if (routingWrite.error) {
      return NextResponse.json({ error: routingWrite.error }, { status: 400 });
    }
    const hasRoutingField = Object.prototype.hasOwnProperty.call(body, PROVIDER_ROUTING_FIELD);

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (priority !== undefined) updateData.priority = priority;
    if (globalPriority !== undefined) updateData.globalPriority = globalPriority;
    if (defaultModel !== undefined) updateData.defaultModel = defaultModel;
    if (isActive !== undefined) updateData.isActive = isActive;
    if (apiKey && existing.authType === "apikey") updateData.apiKey = apiKey;
    if (testStatus !== undefined) updateData.testStatus = testStatus;
    if (lastError !== undefined) updateData.lastError = lastError;
    if (lastErrorAt !== undefined) updateData.lastErrorAt = lastErrorAt;

    if (
      shouldMergeProviderSpecificData(
        existing.providerSpecificData,
        providerSpecificData,
        proxyConfig.hasAnyProxyField,
        proxyPoolResult.hasProxyPoolField || hasTlsField || hasRoutingField
      )
    ) {
      // Responses redact secrets, so a form built from one echoes back blanks, has<Field>
      // flags and masked URLs. Those must not overwrite what is stored.
      const incomingProviderSpecificData = {
        ...restoreRedacted(providerSpecificData || {}, existing.providerSpecificData),
      };
      const isAwsCredential = usesAwsCredentialForm(existing.provider);
      // The edit form cannot read the stored token back. An empty password field means
      // keep the saved credential; null explicitly removes it.
      if (isAwsCredential && incomingProviderSpecificData.sessionToken === "") {
        delete incomingProviderSpecificData.sessionToken;
      }
      updateData.providerSpecificData = {
        ...existing.providerSpecificData,
        ...incomingProviderSpecificData,
      };
      if (isAwsCredential && incomingProviderSpecificData.sessionToken === null) {
        delete updateData.providerSpecificData.sessionToken;
      }

      if (proxyConfig.hasAnyProxyField) {
        updateData.providerSpecificData.connectionProxyEnabled = proxyConfig.connectionProxyEnabled;
        updateData.providerSpecificData.connectionProxyUrl = restoreMaskedUrl(
          proxyConfig.connectionProxyUrl,
          existing.providerSpecificData?.connectionProxyUrl
        );
        updateData.providerSpecificData.connectionNoProxy = proxyConfig.connectionNoProxy;
      }

      // Only store a validated { browser, os } — whether it came top-level or inside providerSpecificData.
      const tlsInput = hasTlsField ? body.tlsImpersonation : updateData.providerSpecificData.tlsImpersonation;
      const tls = normalizeTlsImpersonation(tlsInput);
      if (tls) updateData.providerSpecificData.tlsImpersonation = tls;
      else delete updateData.providerSpecificData.tlsImpersonation;

      // Upstream routing: the validated value when one was sent (null clears it); otherwise
      // the stored value, re-normalized so nothing unvalidated survives an unrelated edit.
      // Providers without the quirk never keep one (the executor would ignore it anyway).
      const routing = !supportsProviderRouting(existing.provider)
        ? null
        : routingWrite.supplied
          ? routingWrite.routing
          : normalizeProviderRouting(updateData.providerSpecificData[PROVIDER_ROUTING_FIELD]);
      if (routing) updateData.providerSpecificData[PROVIDER_ROUTING_FIELD] = routing;
      else delete updateData.providerSpecificData[PROVIDER_ROUTING_FIELD];

      if (proxyPoolResult.hasProxyPoolField) {
        if (proxyPoolResult.proxyPoolId === null) {
          delete updateData.providerSpecificData.proxyPoolId;
        } else {
          updateData.providerSpecificData.proxyPoolId = proxyPoolResult.proxyPoolId;
        }
      }
    }

    const updated = await updateProviderConnection(id, updateData);

    return NextResponse.json({ connection: toProviderConnectionResponse(updated) });
  } catch (error) {
    if (error instanceof MaskedUrlError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.log("Error updating connection:", error);
    return NextResponse.json({ error: "Failed to update connection" }, { status: 500 });
  }
}

// DELETE /api/providers/[id] - Delete connection
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const deleted = await deleteProviderConnection(id);
    if (!deleted) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Connection deleted successfully" });
  } catch (error) {
    console.log("Error deleting connection:", error);
    return NextResponse.json({ error: "Failed to delete connection" }, { status: 500 });
  }
}
