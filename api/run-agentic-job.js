// api/run-agentic-job.js
// Requester Agent and Worker Agent settle a job in USDC on Arc Testnet.
// Worker does the work -> Requester verifies it -> Requester pays on-chain.
// No human approval step.

const { ethers } = require("ethers");

const ARC_RPC_URL = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
const USDC_ADDRESS = "0x3600000000000000000000000000000000000000"; // 6 decimals
const USDC_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
];

const PAY_PER_TASK = process.env.NANOPAYMENT_USDC || "0.01";
const BUDGET = parseFloat(process.env.MAX_BUDGET_USDC || "0.05");

// Worker Agent: does one unit of work, returns its output
async function doWork(paragraph) {
  const key = process.env.GEMINI_API_KEY;
  const resp = await fetch(
`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Summarize in one short sentence:\n\n${paragraph}` }] }],
      }),
    }
  );
  const data = await resp.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
}

// Requester Agent: decides whether the work is real and affordable
function verify(paragraph, summary, spent) {
  if (!summary) return { ok: false, reason: "empty output — no proof of work" };
  if (summary.length >= paragraph.length) return { ok: false, reason: "not actually a summary" };
  if (spent + parseFloat(PAY_PER_TASK) > BUDGET) return { ok: false, reason: "would exceed budget" };
  return { ok: true, reason: "valid summary, within budget" };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const { text, workerAddress } = req.body || {};
    if (!text || !workerAddress) {
      return res.status(400).json({ error: "Provide text and workerAddress" });
    }

    const provider = new ethers.JsonRpcProvider(ARC_RPC_URL);
    const wallet = new ethers.Wallet(process.env.REQUESTER_PRIVATE_KEY, provider);
    const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, wallet);

    const paragraphs = text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
    const log = [];
    let spent = 0;

    for (const paragraph of paragraphs) {
      const summary = await doWork(paragraph);
      log.push({ agent: "Worker", status: "work", text: summary || "(no output)" });

      const decision = verify(paragraph, summary, spent);
      log.push({ agent: "Requester", status: decision.ok ? "approved" : "rejected", text: decision.reason });

      if (decision.ok) {
        const tx = await usdc.transfer(workerAddress, ethers.parseUnits(PAY_PER_TASK, 6));
        spent += parseFloat(PAY_PER_TASK);
        log.push({ agent: "Requester", status: "paid", text: `$${PAY_PER_TASK} USDC · tx ${tx.hash}` });
      }
    }

    res.status(200).json({ log, spent: spent.toFixed(4) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
