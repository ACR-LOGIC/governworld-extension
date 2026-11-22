export function isEmailDeliveryConfigured(): boolean {
  const apiKey = Deno.env.get("RESEND_API_KEY")?.trim();
  const from = Deno.env.get("GW_GRANT_EMAIL_FROM")?.trim();
  return Boolean(apiKey && apiKey.length > 0 && from && from.length > 0);
}

export async function sendAdminGrantEmail(params: {
  to: string;
  organisationName: string;
  username: string;
  tempPassword: string;
  expiresAt: string;
}): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  const apiKey = Deno.env.get("RESEND_API_KEY")?.trim();
  const from = Deno.env.get("GW_GRANT_EMAIL_FROM")?.trim();

  if (!apiKey || !from) {
    return {
      ok: false,
      error: "Email delivery provider is not configured (RESEND_API_KEY / GW_GRANT_EMAIL_FROM)",
    };
  }

  const subject = `GovernWorld Admin Access Granted — ${params.organisationName}`;
  const text = [
    `You have been granted administrator access for ${params.organisationName}.`,
    ``,
    `Username: ${params.username}`,
    `Temporary Password: ${params.tempPassword}`,
    `Expires At (UTC): ${params.expiresAt}`,
    ``,
    `You must change this temporary password on first login before accessing any administrator actions.`,
  ].join("\n");

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [params.to],
        subject,
        text,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return {
        ok: false,
        error: `Email provider rejected request (${res.status}): ${detail.slice(0, 200)}`,
      };
    }

    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, messageId: data.id ?? "sent" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Email dispatch failed",
    };
  }
}
