import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MonthInput } from "../../../components/month-input";
import "../../../app/globals.css";

function Fixture() {
  const [month, setMonth] = useState("2026-11");
  return <main style={{ padding: "24px", fontWeight: 800 }}>
    <button type="button">入力の前</button>
    <label style={{ display: "block", width: "98px", margin: "16px 0" }}>
      <span data-testid="month-label">対象月</span>
      <MonthInput value={month} min="0001-06" max="2026-11" required onChange={event => setMonth(event.target.value)} />
    </label>
    <output data-testid="selected-month">{month}</output>
    <div>
      <button type="button" onClick={() => setMonth("2025-12")}>年末</button>
      <button type="button" onClick={() => setMonth("2026-01")}>年始</button>
      <button type="button" onClick={() => setMonth("2026-11")}>今月</button>
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
