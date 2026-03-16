import { loadConfig } from "../config";
import { getPg } from "../db/pg";
import { getSqlite } from "../db/sqlite";

export interface GraphNode {
  name: string;
  id: number;
}

export interface GraphEdge {
  source: number;
  target: number;
  count: number;
}

export async function cmdGraph(repoRoot: string, format: string) {
  const config = await loadConfig(repoRoot);

  let rows: Array<{ source_repo_id: number; target_repo_id: number; cnt: number }>;
  let repoNames: Map<number, string>;

  if (config.store === "pg") {
    const pg = await getPg();
    const edgeRows = await pg`
      SELECT source_repo_id, target_repo_id, COUNT(*) as cnt
      FROM cross_repo_edges
      GROUP BY source_repo_id, target_repo_id
    `;
    rows = edgeRows.map((r: Record<string, unknown>) => ({
      source_repo_id: Number(r.source_repo_id),
      target_repo_id: Number(r.target_repo_id),
      cnt: Number(r.cnt),
    }));

    const repoRows = await pg`SELECT id, name FROM repos`;
    repoNames = new Map(
      repoRows.map((r: Record<string, unknown>) => [Number(r.id), String(r.name)]),
    );
  } else {
    const db = await getSqlite(repoRoot);
    const edgeRows = db
      .prepare(
        `SELECT source_repo_id, target_repo_id, COUNT(*) as cnt
         FROM cross_repo_edges
         GROUP BY source_repo_id, target_repo_id`,
      )
      .all() as Array<{ source_repo_id: number; target_repo_id: number; cnt: number }>;
    rows = edgeRows;

    const repoRows = db.prepare(`SELECT id, name FROM repos`).all() as Array<{
      id: number;
      name: string;
    }>;
    repoNames = new Map(repoRows.map((r) => [r.id, r.name]));
  }

  if (rows.length === 0) {
    console.log("No cross-repo edges found.");
    return;
  }

  // Collect unique node IDs immutably via flatMap
  const nodeIds = new Set(rows.flatMap((r) => [r.source_repo_id, r.target_repo_id]));

  const nodes: GraphNode[] = [...nodeIds].map((id) => ({
    name: repoNames.get(id) ?? `repo_${id}`,
    id,
  }));

  const edges: GraphEdge[] = rows.map((r) => ({
    source: r.source_repo_id,
    target: r.target_repo_id,
    count: r.cnt,
  }));

  switch (format) {
    case "json":
      console.log(JSON.stringify({ nodes, edges }, null, 2));
      break;

    case "dot": {
      const dotLines = ["digraph cross_repo {"];
      for (const n of nodes) {
        dotLines.push(`  "${n.name}" [label="${n.name}"];`);
      }
      for (const e of edges) {
        const src = repoNames.get(e.source) ?? `repo_${e.source}`;
        const tgt = repoNames.get(e.target) ?? `repo_${e.target}`;
        dotLines.push(`  "${src}" -> "${tgt}" [label="${e.count}"];`);
      }
      dotLines.push("}");
      console.log(dotLines.join("\n"));
      break;
    }

    case "mermaid":
    default: {
      const mermaidLines = ["graph TD"];
      for (const e of edges) {
        const src = repoNames.get(e.source) ?? `repo_${e.source}`;
        const tgt = repoNames.get(e.target) ?? `repo_${e.target}`;
        // Sanitize names for Mermaid (replace special chars)
        const srcId = `r${e.source}`;
        const tgtId = `r${e.target}`;
        mermaidLines.push(`  ${srcId}["${src}"] -->|${e.count} edges| ${tgtId}["${tgt}"]`);
      }
      console.log(mermaidLines.join("\n"));
      break;
    }
  }
}
