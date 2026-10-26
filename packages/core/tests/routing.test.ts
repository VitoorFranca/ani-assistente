import { describe, expect, it } from "vitest";
import { describeAction } from "../src/describe.js";
import { describeLimits, describeTokens, estimatePlan, type RunRecord } from "../src/estimate.js";
import { classifyRequest, modelOverride } from "../src/prompt.js";

describe("routing", () => {
  it("sends short questions to the quick model and multi-step requests to the task model", () => {
    expect(classifyRequest("Quantas revisões eu tenho hoje?")).toBe("rapido");
    expect(classifyRequest("Anota a tarefa de ler o capítulo 3")).toBe("rapido");
    expect(classifyRequest("Anota a tarefa de revisar o caderno de Biologia celular")).toBe("rapido");
    expect(classifyRequest("Cria um cartão sobre ATP em Fisiologia")).toBe("rapido");
    expect(classifyRequest("Cria vários cartões sobre o ciclo de Krebs a partir do caderno de Bioquímica")).toBe(
      "tarefa",
    );
    expect(classifyRequest("Monta um plano de estudo para o roadmap de Go")).toBe("tarefa");
  });

  it("sends creating or revising a roadmap itself to the roadmap route, not studying one", () => {
    expect(classifyRequest("Cria um roadmap de química orgânica para o vestibular")).toBe("roadmap");
    expect(classifyRequest("Ani, monta uma trilha de estudo de violão")).toBe("roadmap");
    expect(classifyRequest("Revisa o roadmap de Go do catálogo")).toBe("roadmap");
    expect(classifyRequest("Melhora esse roadmap e abre o pull request")).toBe("roadmap");
    expect(classifyRequest("Qual o próximo tópico do roadmap de Go?")).toBe("rapido");
    expect(classifyRequest("Marca o tópico de goroutines do roadmap como feito")).toBe("rapido");
    expect(classifyRequest("Estuda o roadmap de Go comigo passo a passo")).toBe("tarefa");
  });

  it("honors a model named in the request and removes the instruction", () => {
    expect(modelOverride("usa o opus nisso: resume o caderno de Fisiologia")).toEqual({
      model: "opus",
      text: "resume o caderno de Fisiologia",
    });
    expect(modelOverride("Resume o caderno com o Sonnet")).toEqual({ model: "sonnet", text: "Resume o caderno" });
    expect(modelOverride("Quantas revisões tenho?")).toBeNull();
  });
});

describe("estimates", () => {
  it("expects roadmap steps to cost much more (they research and open many pages)", () => {
    expect(estimatePlan([], 2, "sonnet", "roadmap")).toEqual({ low: 80_000, high: 240_000, basis: "padrão" });
  });

  it("uses a default range until there is history, then the history of the same model", () => {
    expect(estimatePlan([], 3, "sonnet")).toEqual({ low: 18_000, high: 45_000, basis: "padrão" });
    const history: RunRecord[] = [10_000, 12_000, 14_000, 16_000].map((perStep, i) => ({
      at: `2026-10-2${i}`,
      kind: "tarefa",
      model: "sonnet",
      steps: 2,
      tokens: perStep * 2,
    }));
    const estimate = estimatePlan(history, 3, "sonnet");
    expect(estimate.basis).toBe("histórico");
    expect(estimate.low).toBe(34_500);
    expect(estimate.high).toBe(43_500);
  });

  it("speaks numbers and limits plainly", () => {
    expect(describeTokens(18_000, 45_000)).toBe("entre 18 e 45 mil tokens");
    expect(describeTokens(9_400, 9_600)).toBe("cerca de 10 mil tokens");
    expect(describeLimits([{ name: "5 horas", utilization: 0.3, resetsAt: null }])).toBe(
      "Você já usou 30% da janela de 5 horas.",
    );
  });
});

describe("approval questions", () => {
  it("turns tool calls into one answerable sentence", () => {
    expect(describeAction("mcp__ani9__ani_criar_nota", { baralho: "Fisiologia", frente: "O que é ATP?" })).toBe(
      "Criar o cartão “O que é ATP?” no baralho Fisiologia?",
    );
    expect(describeAction("mcp__ani9__ani_adicionar_tarefa", { tarefa: "ler o capítulo 3" })).toBe(
      "Anotar a tarefa “ler o capítulo 3”?",
    );
    expect(describeAction("mcp__outro__apagar_tudo", {})).toBe("Permitir a ação apagar tudo?");
  });
});
