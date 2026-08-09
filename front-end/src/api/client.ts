import type { ProcessRequest, ClaimResponse } from "../types/api";

const BASE_URL = import.meta.env.VITE_API_BASE_URL?.trim() || "";

function apiUrl(path: string) {
  return `${BASE_URL}${path}`;
}

async function request<T>(path: string, init: RequestInit) {
  const response = await fetch(apiUrl(path), init);

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const errorMessage =
      payload?.error || response.statusText || "Unknown error";
    throw new Error(errorMessage);
  }

  return response.json() as Promise<T>;
}

export async function processClaim(data: ProcessRequest) {
  return request<ClaimResponse>("/process", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function exportClaims() {
  return fetch(apiUrl("/export"), {
    method: "GET",
  });
}
