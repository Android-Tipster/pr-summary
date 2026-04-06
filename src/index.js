const { Anthropic } = require("@anthropic-ai/sdk");
const { Octokit } = require("@octokit/rest");

const COMMENT_MARKER = "<!-- pr-summary-bot -->";
const MAX_DIFF_CHARS = 40000;

// Label definitions: name -> color (GitHub hex, no #)
const LABEL_COLORS = {
  "type: feature":   "0075ca",
  "type: bugfix":    "d73a4a",
  "type: docs":      "0052cc",
  "type: refactor":  "e4e669",
  "type: chore":     "cfd3d7",
  "type: breaking":  "b60205",
  "size: XS":        "c5def5",
  "size: S":         "c5def5",
  "size: M":         "c5def5",
  "size: L":         "c5def5",
  "size: XL":        "c5def5",
};

function sizeLabel(additions, deletions) {
  const total = additions + deletions;
  if (total <= 10)  return "size: XS";
  if (total <= 50)  return "size: S";
  if (total <= 250) return "size: M";
  if (total <= 500) return "size: L";
  return "size: XL";
}

async function ensureLabel(octokit, owner, repo, name) {
  try {
    await octokit.issues.getLabel({ owner, repo, name });
  } catch {
    try {
      await octokit.issues.createLabel({
        owner,
        repo,
        name,
        color: LABEL_COLORS[name] || "ededed",
      });
    } catch {
      // Label may have been created by a concurrent run — ignore
    }
  }
}

async function run() {
  const token    = process.env.GITHUB_TOKEN;
  const apiKey   = process.env.ANTHROPIC_API_KEY;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repo     = process.env.GITHUB_REPOSITORY;
  const autoLabel = (process.env.AUTO_LABEL || "true") === "true";

  if (!token || !apiKey || !eventPath || !repo) {
    console.error(
      "Missing required env vars: GITHUB_TOKEN, ANTHROPIC_API_KEY, GITHUB_EVENT_PATH, GITHUB_REPOSITORY"
    );
    process.exit(1);
  }

  const [owner, repoName] = repo.split("/");
  const event = require(eventPath);
  const prNumber = event.pull_request?.number || event.number;

  if (!prNumber) {
    console.log("No PR number found in event payload. Skipping.");
    return;
  }

  const client = new Octokit({ auth: token });
  const anthropic = new Anthropic({ apiKey });

  // Fetch PR details
  const { data: pr } = await client.pulls.get({
    owner, repo: repoName, pull_number: prNumber,
  });

  // Fetch the diff
  const { data: diff } = await client.pulls.get({
    owner, repo: repoName, pull_number: prNumber,
    mediaType: { format: "diff" },
  });

  // Fetch changed files list
  const { data: files } = await client.pulls.listFiles({
    owner, repo: repoName, pull_number: prNumber,
  });

  const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
  const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);

  const filesSummary = files
    .map((f) => {
      const icon = { added: "+", removed: "-", renamed: "~" }[f.status] || "M";
      return `${icon} ${f.filename} (+${f.additions} -${f.deletions})`;
    })
    .join("\n");

  // Truncate diff if too large
  const diffStr = typeof diff === "string" ? diff : JSON.stringify(diff, null, 2);
  const truncatedDiff =
    diffStr.length > MAX_DIFF_CHARS
      ? diffStr.slice(0, MAX_DIFF_CHARS) +
        `\n\n... [diff truncated at ${MAX_DIFF_CHARS} chars, ${files.length} files total]`
      : diffStr;

  const prompt = `You are a senior code reviewer. Analyze this pull request and return JSON only.

PR Title: ${pr.title}
PR Description: ${pr.body || "(no description provided)"}
Author: ${pr.user.login}
Base branch: ${pr.base.ref}
Head branch: ${pr.head.ref}

Changed files (${files.length} total, +${totalAdditions} -${totalDeletions}):
${filesSummary}

Diff:
\`\`\`diff
${truncatedDiff}
\`\`\`

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "type": "feature|bugfix|docs|refactor|chore|breaking",
  "what": "2-3 sentence plain English summary of what this PR does",
  "key_changes": ["specific change 1", "specific change 2", "specific change 3"],
  "files_note": "one sentence about which areas of the codebase are touched",
  "concerns": ["concern 1", "concern 2"] or [],
  "reviewer_expertise": "one sentence on what expertise should review this, or null"
}

Rules:
- type "breaking" = removes or changes public API/interfaces in a backwards-incompatible way
- key_changes: 3-6 items, be specific (not "various improvements")
- concerns: real issues only — edge cases, missing tests, security, breaking changes. Empty array if none.
- keep what under 60 words`;

  console.log(`Generating summary for PR #${prNumber}: ${pr.title}`);

  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  let parsed;
  try {
    parsed = JSON.parse(message.content[0].text);
  } catch {
    // Fallback: extract JSON from response if model added text around it
    const match = message.content[0].text.match(/\{[\s\S]*\}/);
    if (match) {
      parsed = JSON.parse(match[0]);
    } else {
      throw new Error("Model returned non-JSON response: " + message.content[0].text.slice(0, 200));
    }
  }

  // Build comment body
  const typeEmoji = {
    feature: "✨", bugfix: "🐛", docs: "📝",
    refactor: "♻️", chore: "🔧", breaking: "💥",
  }[parsed.type] || "📋";

  const concernsSection = parsed.concerns?.length
    ? `**Potential concerns**\n${parsed.concerns.map((c) => `- ${c}`).join("\n")}`
    : "**Potential concerns**\nNone identified.";

  const reviewerSection = parsed.reviewer_expertise
    ? `**Suggested reviewer:** ${parsed.reviewer_expertise}`
    : "";

  const commentBody = `${COMMENT_MARKER}
## ${typeEmoji} PR Summary

**What this PR does**
${parsed.what}

**Key changes**
${parsed.key_changes.map((c) => `- ${c}`).join("\n")}

**Files changed**
${parsed.files_note}

${concernsSection}
${reviewerSection ? "\n" + reviewerSection : ""}

---
*Generated by [pr-summary](https://github.com/Android-Tipster/pr-summary) using Claude Haiku.*`;

  // Upsert comment
  const { data: comments } = await client.issues.listComments({
    owner, repo: repoName, issue_number: prNumber,
  });
  const existing = comments.find((c) => c.body.includes(COMMENT_MARKER));

  if (existing) {
    await client.issues.updateComment({
      owner, repo: repoName, comment_id: existing.id, body: commentBody,
    });
    console.log(`Updated existing summary comment #${existing.id}`);
  } else {
    const { data: nc } = await client.issues.createComment({
      owner, repo: repoName, issue_number: prNumber, body: commentBody,
    });
    console.log(`Created new summary comment #${nc.id}`);
  }

  // Auto-label
  if (autoLabel) {
    const typeLabel = `type: ${parsed.type}`;
    const sz = sizeLabel(totalAdditions, totalDeletions);
    const labelsToAdd = [typeLabel, sz];

    for (const labelName of labelsToAdd) {
      await ensureLabel(client, owner, repoName, labelName);
    }

    // Remove any existing type/size labels that conflict
    const { data: currentLabels } = await client.issues.listLabelsOnIssue({
      owner, repo: repoName, issue_number: prNumber,
    });
    for (const lbl of currentLabels) {
      if (
        (lbl.name.startsWith("type: ") && lbl.name !== typeLabel) ||
        (lbl.name.startsWith("size: ") && lbl.name !== sz)
      ) {
        await client.issues.removeLabel({
          owner, repo: repoName, issue_number: prNumber, name: lbl.name,
        });
      }
    }

    await client.issues.addLabels({
      owner, repo: repoName, issue_number: prNumber, labels: labelsToAdd,
    });
    console.log(`Applied labels: ${labelsToAdd.join(", ")}`);
  }

  console.log("Done.");
}

run().catch((err) => {
  console.error("Action failed:", err.message);
  process.exit(1);
});
