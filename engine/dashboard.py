"""
Dashboard — Investment Portfolio Tracker
=========================================
Avvio:
    streamlit run engine/dashboard.py
    streamlit run engine/dashboard.py -- --file "data/INVESTMENT PORTFOLIO TRACKER (3).xlsx"
"""

import sys
from pathlib import Path

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import streamlit as st

# Permette di eseguire lo script da qualsiasi directory
sys.path.insert(0, str(Path(__file__).parent))
from pnl_engine import (
    load_portfolio,
    compute_pnl,
    apply_display_currency,
    CURRENCY_SYMBOLS,
    PORTFOLIO_SHEETS,
)

# ─── Costanti ─────────────────────────────────────────────────────────────────

DEFAULT_FILE = Path(__file__).parent.parent / "data" / "INVESTMENT PORTFOLIO TRACKER (3).xlsx"
SUPPORTED_DISPLAY_CCY = ["EUR", "USD", "CHF", "GBP", "JPY"]

PALETTE = {
    "positive":     "#26a65b",
    "negative":     "#e74c3c",
    "neutral":      "#95a5a6",
    "bg_card":      "#1e2130",
    "accent":       "#4f8ef7",
    "text_primary": "#f0f2f6",
}

SECTOR_COLORS = px.colors.qualitative.Plotly

# ─── Config pagina ─────────────────────────────────────────────────────────────

st.set_page_config(
    page_title="Investment Portfolio Tracker",
    page_icon="📈",
    layout="wide",
    initial_sidebar_state="expanded",
)

# CSS minimale per le card metriche e la tabella colorata
st.markdown("""
<style>
    .metric-card {
        background: #1e2130;
        border-radius: 10px;
        padding: 16px 20px;
        margin-bottom: 8px;
        border-left: 4px solid #4f8ef7;
    }
    .metric-card .label { font-size: 13px; color: #9ba3b2; margin-bottom: 4px; }
    .metric-card .value { font-size: 22px; font-weight: 700; color: #f0f2f6; }
    .metric-card .delta { font-size: 13px; margin-top: 2px; }
    .pos { color: #26a65b; }
    .neg { color: #e74c3c; }
    .section-title {
        font-size: 16px;
        font-weight: 600;
        color: #9ba3b2;
        text-transform: uppercase;
        letter-spacing: 1px;
        margin: 24px 0 12px 0;
    }
    div[data-testid="stDataFrame"] { border-radius: 8px; overflow: hidden; }
</style>
""", unsafe_allow_html=True)


# ─── Helpers ──────────────────────────────────────────────────────────────────

def fmt_money(v: float, symbol: str = "€", sign: bool = True) -> str:
    prefix = ("+" if v >= 0 else "") if sign else ""
    return f"{prefix}{symbol}{v:,.2f}"


def pct_str(v: float) -> str:
    return f"{'+'if v>=0 else ''}{v:.2f}%"


def color_val(v: float, text: str) -> str:
    cls = "pos" if v >= 0 else "neg"
    return f'<span class="{cls}">{text}</span>'


def metric_card(label: str, value: str, delta: str = "", delta_val: float = 0.0):
    cls = "pos" if delta_val >= 0 else "neg"
    delta_html = f'<div class="delta {cls}">{delta}</div>' if delta else ""
    st.markdown(f"""
    <div class="metric-card">
        <div class="label">{label}</div>
        <div class="value">{value}</div>
        {delta_html}
    </div>
    """, unsafe_allow_html=True)


@st.cache_data(show_spinner=False, ttl=300)
def load_data(file_path: str, use_live: bool) -> dict[str, pd.DataFrame]:
    """Carica e calcola P&L per tutti i fogli. Cacheable."""
    results = {}
    for sheet_name, label in PORTFOLIO_SHEETS.items():
        try:
            df = load_portfolio(file_path, sheet_name)
            if df.empty:
                continue
            pnl = compute_pnl(df, label, use_live=use_live)
            results[label] = pnl
        except Exception as e:
            st.warning(f"Errore nel foglio {sheet_name}: {e}")
    return results


def build_pnl_table(pnl_df: pd.DataFrame, symbol: str) -> pd.DataFrame:
    """Prepara DataFrame formattato per la visualizzazione.
    Richiede un pnl_df già passato per apply_display_currency."""
    return pd.DataFrame({
        "Ticker":          pnl_df["ticker"],
        "Nome":            pnl_df["nome"].str[:24],
        "Settore":         pnl_df["settore"],
        "Valuta nativa":   pnl_df["valuta_nativa"],
        "Qty":             pnl_df["quantita"].round(4),
        f"P.Carico":       pnl_df["prezzo_carico"].round(2),
        f"P.Attuale":      pnl_df["prezzo_attuale"].round(2),
        f"Valore {symbol}": pnl_df["valore_attuale"].round(2),
        f"P&L {symbol}":   pnl_df["pnl"].round(2),
        "P&L %":           pnl_df["pnl_pct"].round(2),
        "Peso %":          pnl_df["peso_pct"].round(1),
    })


def style_pnl_table(df: pd.DataFrame, symbol: str):
    """Applica stile colori e formattazione dipendente dalla valuta di display."""
    val_col = f"Valore {symbol}"
    pnl_col = f"P&L {symbol}"

    def color_neg_pos(weight: str = "normal"):
        def _f(col):
            return [
                f"color: #26a65b; font-weight:{weight}" if v >= 0 else f"color: #e74c3c; font-weight:{weight}"
                for v in col
            ]
        return _f

    return (
        df.style
        .apply(color_neg_pos("600"), subset=[pnl_col])
        .apply(color_neg_pos("normal"), subset=["P&L %"])
        .format({
            "P.Carico":  f"{symbol}{{:,.2f}}",
            "P.Attuale": f"{symbol}{{:,.2f}}",
            val_col:     f"{symbol}{{:,.0f}}",
            pnl_col:     f"{{:+,.2f}}",
            "P&L %":     "{:+.2f}%",
            "Peso %":    "{:.1f}%",
        })
        .set_properties(
            **{"text-align": "right"},
            subset=["Qty", "P.Carico", "P.Attuale", val_col, pnl_col, "P&L %", "Peso %"],
        )
        .set_properties(**{"text-align": "center"}, subset=["Valuta nativa"])
        .set_table_styles([{"selector": "th", "props": [("text-align", "center")]}])
    )


def chart_sector_pie(pnl_df: pd.DataFrame, label: str, symbol: str = "€") -> go.Figure:
    by_sector = (
        pnl_df.groupby("settore")["valore_attuale"]
        .sum()
        .reset_index()
        .sort_values("valore_attuale", ascending=False)
    )
    fig = px.pie(
        by_sector,
        names="settore",
        values="valore_attuale",
        title=f"Allocazione per settore — {label}",
        color_discrete_sequence=SECTOR_COLORS,
        hole=0.4,
    )
    fig.update_traces(
        textposition="outside",
        textinfo="percent+label",
        hovertemplate=f"<b>%{{label}}</b><br>{symbol}%{{value:,.0f}}<br>%{{percent}}<extra></extra>",
    )
    fig.update_layout(
        showlegend=True,
        legend=dict(orientation="v", x=1.02, y=0.5),
        margin=dict(l=0, r=120, t=50, b=0),
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        font_color="#f0f2f6",
    )
    return fig


def chart_pnl_bar(pnl_df: pd.DataFrame, label: str, symbol: str = "€") -> go.Figure:
    df = pnl_df.sort_values("pnl")
    colors = [PALETTE["positive"] if v >= 0 else PALETTE["negative"] for v in df["pnl"]]

    fig = go.Figure(go.Bar(
        x=df["ticker"],
        y=df["pnl"],
        marker_color=colors,
        text=[f"{v:+,.0f}{symbol}" for v in df["pnl"]],
        textposition="outside",
        hovertemplate=(
            f"<b>%{{x}}</b><br>"
            f"P&L: {symbol}%{{y:+,.2f}}<br>"
            f"<extra></extra>"
        ),
    ))
    fig.update_layout(
        title=f"P&L per posizione — {label}",
        xaxis_title=None,
        yaxis_title=f"P&L ({symbol})",
        yaxis=dict(zeroline=True, zerolinecolor="#555", gridcolor="#2a2d3e"),
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        font_color="#f0f2f6",
        margin=dict(l=0, r=0, t=50, b=60),
        showlegend=False,
    )
    return fig


def chart_sector_pnl(pnl_df: pd.DataFrame, label: str, symbol: str = "€") -> go.Figure:
    by_sector = (
        pnl_df.groupby("settore")
        .agg(pnl=("pnl", "sum"), costo=("costo_totale", "sum"))
        .assign(pnl_pct=lambda x: x["pnl"] / x["costo"] * 100)
        .reset_index()
        .sort_values("pnl", ascending=True)
    )
    colors = [PALETTE["positive"] if v >= 0 else PALETTE["negative"] for v in by_sector["pnl"]]
    fig = go.Figure(go.Bar(
        x=by_sector["pnl"],
        y=by_sector["settore"],
        orientation="h",
        marker_color=colors,
        text=[f"{symbol}{v:+,.0f}  ({p:+.1f}%)" for v, p in zip(by_sector["pnl"], by_sector["pnl_pct"])],
        textposition="outside",
        hovertemplate=f"<b>%{{y}}</b><br>P&L: {symbol}%{{x:+,.2f}}<extra></extra>",
    ))
    fig.update_layout(
        title=f"P&L per settore — {label}",
        xaxis=dict(zeroline=True, zerolinecolor="#555", gridcolor="#2a2d3e"),
        yaxis_title=None,
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        font_color="#f0f2f6",
        margin=dict(l=0, r=0, t=50, b=20),
        showlegend=False,
    )
    return fig


def chart_comparison(all_data: dict[str, pd.DataFrame], symbol: str = "€") -> go.Figure:
    """Bar chart fiancato Valore vs Costo per ogni portfolio."""
    labels, values, costs, pcts = [], [], [], []
    for label, pnl_df in all_data.items():
        val  = pnl_df["valore_attuale"].sum()
        cost = pnl_df["costo_totale"].sum()
        pnl  = val - cost
        pct  = (pnl / cost * 100) if cost > 0 else 0
        labels.append(label)
        values.append(val)
        costs.append(cost)
        pcts.append(pct)

    fig = go.Figure()
    fig.add_trace(go.Bar(
        name="Costo investito",
        x=labels,
        y=costs,
        marker_color=PALETTE["neutral"],
        hovertemplate=f"<b>%{{x}}</b><br>Costo: {symbol}%{{y:,.0f}}<extra></extra>",
    ))
    fig.add_trace(go.Bar(
        name="Valore attuale",
        x=labels,
        y=values,
        marker_color=PALETTE["accent"],
        text=[f"P&L {pct_str(p)}" for p in pcts],
        textposition="outside",
        hovertemplate=f"<b>%{{x}}</b><br>Valore: {symbol}%{{y:,.0f}}<extra></extra>",
    ))
    fig.update_layout(
        barmode="group",
        title="Confronto portfolio — Costo vs Valore attuale",
        yaxis=dict(gridcolor="#2a2d3e", tickprefix=symbol),
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        font_color="#f0f2f6",
        legend=dict(orientation="h", y=1.1),
        margin=dict(l=0, r=0, t=70, b=20),
    )
    return fig


def chart_comparison_pnl(all_data: dict[str, pd.DataFrame], symbol: str = "€") -> go.Figure:
    """P&L per settore — barre per portfolio."""
    fig = go.Figure()
    for label, pnl_df in all_data.items():
        by_sector = (
            pnl_df.groupby("settore")["pnl"]
            .sum()
            .reset_index()
            .sort_values("pnl", ascending=False)
        )
        colors = [PALETTE["positive"] if v >= 0 else PALETTE["negative"] for v in by_sector["pnl"]]
        fig.add_trace(go.Bar(
            name=label,
            x=by_sector["settore"],
            y=by_sector["pnl"],
            marker_color=colors,
            hovertemplate=f"<b>{label}</b><br>%{{x}}: {symbol}%{{y:+,.2f}}<extra></extra>",
        ))
    fig.update_layout(
        barmode="group",
        title="P&L per settore — confronto portfolio",
        yaxis=dict(zeroline=True, zerolinecolor="#555", gridcolor="#2a2d3e", tickprefix=symbol),
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        font_color="#f0f2f6",
        legend=dict(orientation="h", y=1.1),
        margin=dict(l=0, r=0, t=70, b=20),
    )
    return fig


# ─── Sidebar ──────────────────────────────────────────────────────────────────

def sidebar() -> tuple[str, bool, str]:
    with st.sidebar:
        st.title("📈 Portfolio Tracker")
        st.markdown("---")

        # File picker
        st.markdown("**File Excel**")
        file_path = st.text_input(
            "Percorso file",
            value=str(DEFAULT_FILE),
            label_visibility="collapsed",
        )

        st.markdown("---")
        st.markdown("**Prezzi**")
        use_live = st.toggle("Aggiorna prezzi live (yfinance)", value=True)

        if use_live:
            st.caption("Cache 5 min — usa 'Aggiorna' per forzare.")

        st.markdown("---")
        st.markdown("**Valuta di riferimento**")
        display_ccy = st.selectbox(
            "Valuta visualizzata",
            options=SUPPORTED_DISPLAY_CCY,
            index=0,
            label_visibility="collapsed",
            help="Tutti i prezzi e i totali vengono convertiti in questa valuta usando i cambi live di yfinance.",
        )

        st.markdown("---")

        col1, col2 = st.columns(2)
        with col1:
            refresh = st.button("🔄 Aggiorna", use_container_width=True, type="primary")
        with col2:
            clear = st.button("🗑 Pulisci cache", use_container_width=True)

        if refresh or clear:
            st.cache_data.clear()
            st.rerun()

        st.markdown("---")
        st.caption("Investment Portfolio Tracker\nPowered by yfinance + Streamlit")

    return file_path, use_live, display_ccy


# ─── Sezioni portfolio ─────────────────────────────────────────────────────────

def render_portfolio_section(label: str, pnl_df: pd.DataFrame, symbol: str):
    """pnl_df deve essere già passato per apply_display_currency."""
    total_val  = pnl_df["valore_attuale"].sum()
    total_cost = pnl_df["costo_totale"].sum()
    total_pnl  = pnl_df["pnl"].sum()
    total_pct  = (total_pnl / total_cost * 100) if total_cost > 0 else 0.0
    n_pos      = len(pnl_df)
    n_win      = (pnl_df["pnl"] > 0).sum()

    # KPI row
    k1, k2, k3, k4, k5 = st.columns(5)
    with k1:
        metric_card("Valore attuale", f"{symbol}{total_val:,.0f}")
    with k2:
        metric_card("Costo investito", f"{symbol}{total_cost:,.0f}")
    with k3:
        metric_card("P&L totale", fmt_money(total_pnl, symbol), pct_str(total_pct), total_pnl)
    with k4:
        metric_card("Posizioni", str(n_pos), f"{n_win} in guadagno", n_win)
    with k5:
        best = pnl_df.loc[pnl_df["pnl_pct"].idxmax()]
        metric_card("Miglior pos.", best["ticker"], pct_str(best["pnl_pct"]), best["pnl_pct"])

    # Tabella P&L
    st.markdown('<div class="section-title">Dettaglio posizioni</div>', unsafe_allow_html=True)

    # Filtri di riga (la valuta di visualizzazione è gestita nella sidebar)
    all_sectors = sorted(pnl_df["settore"].unique().tolist())
    fc1, fc2 = st.columns([3, 1])
    with fc1:
        sel_sec = st.multiselect("Filtra settori", all_sectors, default=all_sectors, key=f"sec_{label}")
    with fc2:
        solo_gain = st.checkbox("Solo in guadagno", key=f"gain_{label}")

    filtered = pnl_df[
        pnl_df["settore"].isin(sel_sec) &
        (~solo_gain | (pnl_df["pnl"] > 0))
    ]

    display_df = build_pnl_table(filtered, symbol)
    st.dataframe(
        style_pnl_table(display_df, symbol),
        use_container_width=True,
        hide_index=True,
        height=min(40 + len(filtered) * 35, 520),
    )

    # Grafici
    st.markdown('<div class="section-title">Analisi</div>', unsafe_allow_html=True)
    c1, c2 = st.columns([1, 1])
    with c1:
        st.plotly_chart(chart_sector_pie(pnl_df, label, symbol), use_container_width=True)
    with c2:
        st.plotly_chart(chart_sector_pnl(pnl_df, label, symbol), use_container_width=True)

    st.plotly_chart(chart_pnl_bar(pnl_df, label, symbol), use_container_width=True)


def render_comparison(all_data: dict[str, pd.DataFrame], symbol: str):
    st.markdown('<div class="section-title">Confronto portfolio</div>', unsafe_allow_html=True)

    # KPI confronto
    cols = st.columns(len(all_data))
    for col, (label, pnl_df) in zip(cols, all_data.items()):
        val   = pnl_df["valore_attuale"].sum()
        cost  = pnl_df["costo_totale"].sum()
        pnl   = val - cost
        pct   = (pnl / cost * 100) if cost > 0 else 0
        with col:
            st.markdown(f"#### {label}")
            metric_card("Valore", f"{symbol}{val:,.0f}", fmt_money(pnl, symbol) + f" ({pct_str(pct)})", pnl)

    c1, c2 = st.columns(2)
    with c1:
        st.plotly_chart(chart_comparison(all_data, symbol), use_container_width=True)
    with c2:
        st.plotly_chart(chart_comparison_pnl(all_data, symbol), use_container_width=True)

    # Tabella riassuntiva
    st.markdown('<div class="section-title">Riepilogo</div>', unsafe_allow_html=True)
    val_col  = f"Valore {symbol}"
    cost_col = f"Costo {symbol}"
    pnl_col  = f"P&L {symbol}"
    summary_rows = []
    for label, pnl_df in all_data.items():
        val  = pnl_df["valore_attuale"].sum()
        cost = pnl_df["costo_totale"].sum()
        pnl  = val - cost
        pct  = (pnl / cost * 100) if cost > 0 else 0
        best  = pnl_df.loc[pnl_df["pnl_pct"].idxmax()]
        worst = pnl_df.loc[pnl_df["pnl_pct"].idxmin()]
        summary_rows.append({
            "Portfolio":     label,
            "Posizioni":     len(pnl_df),
            val_col:         round(val, 0),
            cost_col:        round(cost, 0),
            pnl_col:         round(pnl, 2),
            "P&L %":         round(pct, 2),
            "Miglior pos.":  f"{best['ticker']} ({pct_str(best['pnl_pct'])})",
            "Peggior pos.":  f"{worst['ticker']} ({pct_str(worst['pnl_pct'])})",
        })
    summary_df = pd.DataFrame(summary_rows)

    def style_summary(df):
        def c(col):
            return ["color: #26a65b; font-weight:600" if v >= 0 else "color: #e74c3c; font-weight:600" for v in col]
        return (
            df.style
            .apply(c, subset=[pnl_col, "P&L %"])
            .format({
                val_col:  f"{symbol}{{:,.0f}}",
                cost_col: f"{symbol}{{:,.0f}}",
                pnl_col:  "{:+,.2f}",
                "P&L %":  "{:+.2f}%",
            })
        )

    st.dataframe(style_summary(summary_df), use_container_width=True, hide_index=True)


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    file_path, use_live, display_ccy = sidebar()
    symbol = CURRENCY_SYMBOLS.get(display_ccy, display_ccy)

    st.title("📊 Investment Portfolio Tracker")
    st.caption(f"File: `{file_path}` • Visualizzazione in **{display_ccy}**")

    if not Path(file_path).exists():
        st.error(f"File non trovato: `{file_path}`\nModifica il percorso nella sidebar.")
        st.stop()

    with st.spinner("Caricamento dati..."):
        all_data_eur = load_data(file_path, use_live)

    if not all_data_eur:
        st.error("Nessun portfolio caricato. Controlla il file e i nomi dei fogli.")
        st.stop()

    # Conversione alla valuta di visualizzazione (operazione cheap, non cached)
    all_data = {
        label: apply_display_currency(df, display_ccy)
        for label, df in all_data_eur.items()
    }

    # Tabs: uno per portfolio + confronto (se più di uno)
    tab_names = list(all_data.keys())
    if len(all_data) >= 2:
        tab_names.append("📊 Confronto")

    tabs = st.tabs([f"👤 {n}" if n != "📊 Confronto" else n for n in tab_names])

    for i, (label, pnl_df) in enumerate(all_data.items()):
        with tabs[i]:
            render_portfolio_section(label, pnl_df, symbol)

    if len(all_data) >= 2:
        with tabs[-1]:
            render_comparison(all_data, symbol)


if __name__ == "__main__":
    main()
