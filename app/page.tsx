"use client";

import { useMemo, useState } from "react";

type LookupResponse = {
  geocode: {
    query: string;
    candidates: Array<{
      formatted_address: string;
      place_id: string | null;
      lat: number | null;
      lng: number | null;
      address_components: any;
    }>;
    selectedIndex: number;
  };
  place: any | null;
  warnings: string[];
  latencyMs?: number;
};

export default function LocationLookup() {
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<LookupResponse | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number>(0);

  const selectedCandidate = useMemo(() => {
    if (!data) return null;
    return data.geocode.candidates[data.geocode.selectedIndex] ?? null;
  }, [data]);

  async function submitLookup(idxOverride?: number) {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, selectedIndex: idxOverride ?? selectedIndex }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Request failed (${res.status})`);
      }
      const j: LookupResponse = await res.json();
      setData(j);
      setSelectedIndex(j.geocode.selectedIndex);
    } catch (e: any) {
      setError(e.message || "Unexpected error");
    } finally {
      setLoading(false);
    }
  }

  function renderField(label: string, value: any) {
    const has = value !== undefined && value !== null && value !== "";
    return (
      <div className="grid grid-cols-3 gap-2 py-1 border-b border-gray-100">
        <div className="font-medium text-gray-700">{label}</div>
        <div className="col-span-2 break-all">{has ? String(value) : <span className="text-gray-400">Not available</span>}</div>
      </div>
    );
  }

  function copyJson() {
    if (!data) return;
    navigator.clipboard.writeText(JSON.stringify(data, null, 2));
  }

  return (
    <main className="mx-auto max-w-4xl p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Location Lookup</h1>

      <div className="rounded-lg border p-4 space-y-3">
        <label htmlFor="addr" className="block text-sm font-medium">Street address</label>
        <input
          id="addr"
          type="text"
          value={address}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAddress(e.target.value)}
          className="w-full rounded border px-3 py-2 focus:outline-none focus:ring"
          placeholder="1600 Amphitheatre Parkway, Mountain View, CA"
        />
        <div className="flex items-center gap-3">
          <button
            onClick={() => submitLookup()}
            disabled={loading || !address.trim()}
            className="rounded bg-indigo-600 px-4 py-2 text-white disabled:opacity-50"
          >
            {loading ? "Looking up..." : "Submit"}
          </button>
          {data?.latencyMs != null && (
            <span className="text-sm text-gray-500">Latency: {data.latencyMs} ms</span>
          )}
        </div>
        {error && <div className="text-red-600 text-sm">{error}</div>}
      </div>

      {data && (
        <div className="space-y-6">
          {data.warnings.length > 0 && (
            <ul className="rounded border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-900">
              {data.warnings.map((w, i) => (
                <li key={i}>• {w}</li>
              ))}
            </ul>
          )}

          <section className="rounded-lg border p-4 space-y-3">
            <h2 className="text-lg font-semibold">Summary</h2>
            {data.geocode.candidates.length > 1 && (
              <div className="flex items-center gap-2">
                <label className="text-sm">Select candidate:</label>
                <select
                  value={selectedIndex}
                  onChange={async (e: React.ChangeEvent<HTMLSelectElement>) => {
                    const idx = Number(e.target.value);
                    setSelectedIndex(idx);
                    await submitLookup(idx);
                  }}
                  className="rounded border px-2 py-1"
                >
                  {data.geocode.candidates.map((c, i) => (
                    <option key={i} value={i}>{c.formatted_address}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="grid md:grid-cols-2 gap-4">
              <div className="rounded border p-3">
                <div className="font-medium mb-2">Geocoding Candidate</div>
                {selectedCandidate ? (
                  <div className="text-sm space-y-1">
                    {renderField("Address", selectedCandidate.formatted_address)}
                    {renderField("place_id", selectedCandidate.place_id)}
                    {renderField("lat", selectedCandidate.lat)}
                    {renderField("lng", selectedCandidate.lng)}
                  </div>
                ) : (
                  <div className="text-sm text-gray-500">No candidate selected</div>
                )}
              </div>

              <div className="rounded border p-3">
                <div className="font-medium mb-2">Place Details</div>
                {data.place ? (
                  <div className="text-sm space-y-1">
                    {renderField("name", data.place.name)}
                    {renderField("formatted_address", data.place.formatted_address)}
                    {renderField("types", Array.isArray(data.place.types) ? data.place.types.join(", ") : data.place.types)}
                    {renderField("business_status", data.place.business_status)}
                    {renderField("formatted_phone_number", data.place.formatted_phone_number)}
                    {renderField("international_phone_number", data.place.international_phone_number)}
                    {renderField("website", data.place.website)}
                    {renderField("url", data.place.url)}
                    {renderField("rating", data.place.rating)}
                    {renderField("user_ratings_total", data.place.user_ratings_total)}
                    {renderField("price_level", data.place.price_level)}
                  </div>
                ) : (
                  <div className="text-sm text-gray-500">Place details not available</div>
                )}
                {data.place?.url && (
                  <div className="mt-2">
                    <a className="text-indigo-600 underline" href={data.place.url} target="_blank" rel="noreferrer">Open in Google Maps</a>
                  </div>
                )}
              </div>
            </div>
          </section>

          <details className="rounded-lg border p-4">
            <summary className="cursor-pointer text-lg font-semibold">Raw JSON</summary>
            <div className="mt-3">
              <button onClick={copyJson} className="mb-2 rounded bg-gray-800 px-3 py-1 text-white">Copy JSON</button>
              <pre className="max-h-96 overflow-auto bg-gray-100 p-3 text-xs">{JSON.stringify(data, null, 2)}</pre>
            </div>
          </details>
        </div>
      )}
    </main>
  );
}
