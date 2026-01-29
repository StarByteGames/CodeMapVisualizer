import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "codemapvisualizer.umlView",
      new UMLWebviewViewProvider(context),
    ),
  );
}

class UMLWebviewViewProvider implements vscode.WebviewViewProvider {
  private escapeRegExp(str: string): string {
    return str.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    webviewView.webview.options = {
      enableScripts: true,
    };

    const files = await vscode.workspace.findFiles("**/*.cs");
    let allCode = "";

    for (const file of files) {
      try {
        const doc = await vscode.workspace.openTextDocument(file);
        allCode += doc.getText() + "\n";
      } catch (e) {}
    }

    webviewView.webview.html = this.getHtmlFromCode(allCode);

    vscode.workspace.onDidSaveTextDocument(
      async () => {
        let updatedCode = "";
        const files = await vscode.workspace.findFiles("**/*.cs");
        for (const file of files) {
          try {
            const doc = await vscode.workspace.openTextDocument(file);
            updatedCode += doc.getText() + "\n";
          } catch (e) {}
        }
        webviewView.webview.html = this.getHtmlFromCode(updatedCode);
      },
      null,
      this.context.subscriptions,
    );
  }

  private getHtmlFromCode(code: string): string {
    const classRegex = /class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([A-Za-z_][A-Za-z0-9_]*))?/g;
    let classSet = new Set<string>();
    let relationSet = new Set<string>();
    let relations: {
      child: string;
      parent: string;
      type: "inheritance" | "usage";
    }[] = [];

    let match;
    type ClassBlock = { name: string; body: string };
    let classBlocks: ClassBlock[] = [];

    while ((match = classRegex.exec(code)) !== null) {
      const className = match[1];
      const parentName = match[2];

      classSet.add(className);

      let blockStart = code.indexOf("{", match.index);

      if (blockStart === -1) continue;

      let braceCount = 1;
      let blockEnd = blockStart + 1;

      while (braceCount > 0 && blockEnd < code.length) {
        if (code[blockEnd] === "{") braceCount++;
        else if (code[blockEnd] === "}") braceCount--;
        blockEnd++;
      }

      classBlocks.push({
        name: className,
        body: code.slice(blockStart + 1, blockEnd - 1),
      });

      if (parentName) {
        classSet.add(parentName);

        const relKey = `${parentName} <|-- ${className}`;

        if (!relationSet.has(relKey)) {
          relations.push({
            child: className,
            parent: parentName,
            type: "inheritance",
          });
          relationSet.add(relKey);
        }
      }
    }

    for (const fromBlock of classBlocks) {
      for (const toClass of classSet) {
        if (fromBlock.name === toClass) continue;

        const toClassEsc = this.escapeRegExp(toClass);
        const usageRegex = new RegExp(`new\\s+${toClassEsc}\\s*\\(`);

        if (usageRegex.test(fromBlock.body)) {
          const relKey = `${fromBlock.name} ..> ${toClass}`;
          if (!relationSet.has(relKey)) {
            relations.push({
              child: toClass,
              parent: fromBlock.name,
              type: "usage",
            });
            relationSet.add(relKey);
          }
        }

        const staticUsageRegex = new RegExp(
          `${toClassEsc}\\s*\\.\\s*[A-Za-z_][A-Za-z0-9_]*`,
        );

        if (staticUsageRegex.test(fromBlock.body)) {
          const relKey = `${fromBlock.name} ..> ${toClass}`;
          if (!relationSet.has(relKey)) {
            relations.push({
              child: toClass,
              parent: fromBlock.name,
              type: "usage",
            });
            relationSet.add(relKey);
          }
        }

        const typeUsageRegex = new RegExp(
          `(?:^|[^A-Za-z0-9_])${toClassEsc}(?:\\?|\\b|<|\\[)`,
          "g",
        );

        if (typeUsageRegex.test(fromBlock.body)) {
          const relKey = `${fromBlock.name} ..> ${toClass}`;
          if (!relationSet.has(relKey)) {
            relations.push({
              child: toClass,
              parent: fromBlock.name,
              type: "usage",
            });
            relationSet.add(relKey);
          }
        }
      }
    }

    const elkNodes = Array.from(classSet).map((cls) => {
      const charWidth = 8;
      const padding = 24;
      const minWidth = 120;
      const width = Math.max(minWidth, cls.length * charWidth + padding);
      return {
        id: cls,
        width,
        height: 50,
      };
    });

    const elkEdges = relations.map((rel) => ({
      id: rel.parent + "_" + rel.child + "_" + rel.type,
      sources: [rel.parent],
      targets: [rel.child],
      labels: [{ text: rel.type === "inheritance" ? "inherits" : "uses" }],
      style: rel.type === "inheritance" ? "inheritance" : "usage",
    }));

    return `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      html,
      body {
        height: 100%;
        width: 100%;
        margin: 0;
        padding: 0;
        background: #181c27;
        color: #e0e6f0;
      }
      body {
        width: 100vw;
        height: 100vh;
        overflow: hidden;
        font-family: sans-serif;
      }
      #elk-canvas {
        width: 100vw;
        height: 100vh;
        background: #23263a;
      }
    </style>
    <script src="https://cdn.jsdelivr.net/npm/elkjs@0.8.1/lib/elk.bundled.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/svg-pan-zoom@3.6.1/dist/svg-pan-zoom.min.js"></script>
  </head>
  <body>
    <svg id="elk-canvas"></svg>
    <script>
      const elk = new window.ELK();
      const graph = {
        id: "root",
        layoutOptions: {
          'elk.algorithm': 'layered',
          'elk.direction': 'DOWN',
          'elk.layered.edgeRouting': 'ORTHOGONAL',
          'elk.layered.mergeEdges': 'false',
          'elk.edgeRouting': 'ORTHOGONAL',
          'elk.spacing.nodeNode': '120',
          'elk.layered.spacing.nodeNodeBetweenLayers': '120',
          'elk.spacing.edgeNodeBetweenLayers': '80',
          'elk.spacing.edgeEdge': '80',
        },
        children: ${JSON.stringify(elkNodes)},
        edges: ${JSON.stringify(elkEdges)}
      };
      elk.layout(graph).then(layout => {
        const svg = document.getElementById('elk-canvas');
        svg.innerHTML = '';
        for (const node of layout.children) {
          svg.innerHTML += \`<rect x="\${node.x}" y="\${node.y}" width="\${node.width}" height="\${node.height}" rx="8" fill="#23263a" stroke="#e0e6f0" stroke-width="2" />\`;
          svg.innerHTML += \`<text x="\${node.x + node.width/2}" y="\${node.y + node.height/2 + 6}" text-anchor="middle" fill="#fff" font-size="16" font-family="sans-serif">\${node.id}</text>\`;
        }
        for (const edge of layout.edges) {
          const sections = edge.sections || [];
          for (const section of sections) {
            let path = \`M\${section.startPoint.x},\${section.startPoint.y}\`;
            if (section.bendPoints) {
              for (const bp of section.bendPoints) {
                path += \` L\${bp.x},\${bp.y}\`;
              }
            }
            path += \` L\${section.endPoint.x},\${section.endPoint.y}\`;
            svg.innerHTML += \`<path d="\${path}" stroke="#aaa" stroke-width="2" fill="none" marker-end="url(#arrowhead)" stroke-dasharray="\${edge.style==='usage'?'6,4':'0'}" />\`;
          }
        }
        svg.innerHTML += \`<defs><marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto" markerUnits="strokeWidth"><polygon points="0 0, 10 3.5, 0 7" fill="#aaa"/></marker></defs>\`;
        if (window.svgPanZoom) {
          window.svgPanZoom(svg, {
            zoomEnabled: true,
            controlIconsEnabled: false,
            fit: true,
            center: true,
            minZoom: 0.1,
            maxZoom: 20,
            panEnabled: true,
            dblClickZoomEnabled: true,
            mouseWheelZoomEnabled: true,
            beforePan: function() { return true; }
          });
        }
      });
    </script>
  </body>
</html>
    `;
  }
}
