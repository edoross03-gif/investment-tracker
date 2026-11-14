import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Trash2, Plus } from "lucide-react";
import { toast } from "sonner";
import {
  parseRevolut, parseCryptoCom, readStatements, loadUsdEurRates,
  type ParsedPosition, type ParsedRealized, type Source,
} from "@/lib/parsers";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/upload")({
  head: () => ({ meta: [{ title: "Upload — Portfolio" }] }),
  component: UploadPage,
});

type EditableRow = ParsedPosition & { _key: string };

function makeKey() {
  return Math.random().toString(36).slice(2);
}

function UploadPage() {
  const navigate = useNavigate();
  const [source, setSource] = useState<Source>("revolut");
  const [files, setFiles] = useState<File[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [rows, setRows] = useState<EditableRow[]>([]);
  const [realized, setRealized] = useState<ParsedRealized[]>([]);
  const [droppedCount, setDroppedCount] = useState(0);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);

  const totalQty = useMemo(
    () => rows.reduce((s, r) => s + (Number(r.quantity) || 0), 0),
    [rows]
  );

  async function onParse() {
    if (files.length === 0) { toast.error("Choose a file first."); return; }
    setParsing(true);
    try {
      const raw = await readStatements(files);
      const extraNotes: string[] = [];
      let parsed;
      if (source === "revolut") {
        parsed = parseRevolut(raw);
      } else {
        // Rows valued in USD are converted to EUR at the rate of their own date.
        const usdDates = raw
          .filter((r) => String(r["Native Currency"]) === "USD" && r["Timestamp (UTC)"])
          .map((r) => String(r["Timestamp (UTC)"]));
        const fx = await loadUsdEurRates(usdDates);
        if (fx.approximate) {
          extraNotes.push(
            "Historical USD/EUR rates could not be loaded: amounts in USD were converted at a fixed 0.92."
          );
        }
        parsed = parseCryptoCom(raw, fx.lookup);
      }
      setNotes([...parsed.notes, ...extraNotes]);
      const dropped = parsed.positions.filter((r) => !(r.quantity > 0)).length;
      const kept = parsed.positions
        .filter((r) => r.quantity > 0)
        .map((r) => ({ ...r, _key: makeKey() }));
      setRows(kept);
      setRealized(parsed.realized);
      setDroppedCount(dropped);
      toast.success(`Parsed ${kept.length} positions, ${parsed.realized.length} realized (${dropped} dropped).`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setParsing(false);
    }
  }

  function updateRow(key: string, patch: Partial<EditableRow>) {
    setRows((rs) => rs.map((r) => (r._key === key ? { ...r, ...patch } : r)));
  }
  function deleteRow(key: string) {
    setRows((rs) => rs.filter((r) => r._key !== key));
  }
  function addRow() {
    setRows((rs) => [...rs, {
      _key: makeKey(),
      ticker: "", name: null, platform: source,
      asset_type: source === "crypto.com" ? "crypto" : "stock",
      quantity: 0, avg_buy_price: 0,
      buy_currency: "EUR", native_currency: "USD", manual_price: false,
    }]);
  }

  async function onSave() {
    const clean = rows
      .map((r) => ({
        ticker: r.ticker.trim().toUpperCase(),
        name: r.name,
        platform: source,
        asset_type: r.asset_type,
        quantity: Number(r.quantity),
        avg_buy_price: Number(r.avg_buy_price),
        buy_currency: r.buy_currency || "EUR",
        native_currency: r.native_currency,
        manual_price: !!r.manual_price,
      }))
      .filter((r) => r.ticker && r.quantity > 0);

    if (clean.length === 0 && realized.length === 0) {
      toast.error("No valid rows to save."); return;
    }

    setSaving(true);
    try {
      const { error: delErr } = await supabase
        .from("positions").delete().eq("platform", source);
      if (delErr) throw delErr;

      const { error: delRzErr } = await supabase
        .from("realized_pnl").delete().eq("platform", source);
      if (delRzErr) throw delRzErr;

      if (clean.length > 0) {
        const { error: insErr } = await supabase.from("positions").insert(clean);
        if (insErr) throw insErr;
      }

      if (realized.length > 0) {
        const { error: insRzErr } = await supabase
          .from("realized_pnl")
          .insert(realized.map((r) => ({
            platform: r.platform,
            ticker: r.ticker,
            kind: r.kind,
            realized_eur: r.realized_eur,
          })));
        if (insRzErr) throw insRzErr;
      }

      await supabase.from("upload_history").insert({
        source, rows_processed: clean.length,
      });

      toast.success(`Saved ${clean.length} positions, ${realized.length} realized to ${source}.`);
      navigate({ to: "/dashboard" });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Upload positions</h1>
        <p className="text-sm text-muted-foreground">
          Import a Revolut or Crypto.com export. Review, edit, then save.
        </p>
      </div>

      <div className="grid gap-4 rounded-xl border border-border bg-card p-6 sm:grid-cols-[1fr_220px_auto]">
        <div className="space-y-1.5">
          <Label htmlFor="file">Statements (.csv or .xlsx)</Label>
          <Input
            id="file" type="file" accept=".csv,.xlsx,.xls" multiple
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          />
          <p className="text-xs text-muted-foreground">
            Select every statement of the platform at once, from the first one. A statement read
            alone starts from zero and gets quantities and costs wrong.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label>Source</Label>
          <Select value={source} onValueChange={(v) => setSource(v as Source)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="revolut">Revolut</SelectItem>
              <SelectItem value="crypto.com">Crypto.com</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end">
          <Button onClick={onParse} disabled={parsing || files.length === 0} className="w-full sm:w-auto">
            {parsing ? "Parsing…" : "Parse & preview"}
          </Button>
        </div>
      </div>

      {notes.map((n) => (
        <div key={n} className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300">
          {n}
        </div>
      ))}

      {droppedCount > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300">
          {droppedCount} row{droppedCount === 1 ? "" : "s"} dropped (quantity ≤ 0).
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {rows.length} rows · total qty {totalQty}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={addRow}>
                <Plus className="mr-1 h-4 w-4" /> Add row
              </Button>
              <Button size="sm" onClick={onSave} disabled={saving}>
                {saving ? "Saving…" : `Save to ${source}`}
              </Button>
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ticker</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead className="text-right">Avg buy (EUR)</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r._key}>
                    <TableCell>
                      <Input
                        value={r.ticker}
                        onChange={(e) => updateRow(r._key, { ticker: e.target.value })}
                        className="h-8 font-mono"
                      />
                    </TableCell>
                    <TableCell>
                      <Select
                        value={r.asset_type}
                        onValueChange={(v) => updateRow(r._key, { asset_type: v as ParsedPosition["asset_type"] })}
                      >
                        <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="crypto">crypto</SelectItem>
                          <SelectItem value="stock">stock</SelectItem>
                          <SelectItem value="etf">etf</SelectItem>
                          <SelectItem value="bond">bond</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number" step="any" value={r.quantity}
                        onChange={(e) => updateRow(r._key, { quantity: Number(e.target.value) })}
                        className="h-8 text-right font-mono"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number" step="any" value={r.avg_buy_price}
                        onChange={(e) => updateRow(r._key, { avg_buy_price: Number(e.target.value) })}
                        className="h-8 text-right font-mono"
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost" size="icon" className="h-8 w-8"
                        onClick={() => deleteRow(r._key)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {realized.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold tracking-tight">
            Parsed realized P&L ({realized.length})
            <span className="ml-2 text-xs font-normal text-muted-foreground">read-only · saved with positions</span>
          </h2>
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ticker</TableHead>
                  <TableHead>Platform</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead className="text-right">Amount (EUR)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {realized.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-sm">{r.ticker}</TableCell>
                    <TableCell className="text-muted-foreground">{r.platform}</TableCell>
                    <TableCell className="text-muted-foreground">{r.kind}</TableCell>
                    <TableCell className={cn(
                      "text-right font-mono",
                      r.realized_eur >= 0 ? "text-emerald-400" : "text-rose-400"
                    )}>
                      {r.realized_eur.toFixed(2)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
