import { describe, expect, it } from "vitest";
import { takeSentences, wakeRequest, yesOrNo } from "../src/main/voice.js";

describe("takeSentences", () => {
  it("cuts finished sentences and keeps the one still being written", () => {
    expect(takeSentences("Você tem 39 revisões para hoje, 37 atrasadas. Também há 26 cartões novos dispo")).toEqual({
      ready: ["Você tem 39 revisões para hoje, 37 atrasadas."],
      rest: "Também há 26 cartões novos dispo",
    });
  });

  it("does not cut decimals or a sentence whose end may still grow", () => {
    expect(takeSentences("A versão 3.5 saiu")).toEqual({ ready: [], rest: "A versão 3.5 saiu" });
    expect(takeSentences("Anotei a tarefa de revisar Fisiologia.")).toEqual({
      ready: [],
      rest: "Anotei a tarefa de revisar Fisiologia.",
    });
  });

  it("joins a short sentence with the next instead of speaking it alone", () => {
    expect(takeSentences("Pronto. Anotei a tarefa de revisar o capítulo três. E")).toEqual({
      ready: ["Pronto. Anotei a tarefa de revisar o capítulo três."],
      rest: "E",
    });
  });

  it("treats line breaks as sentence ends", () => {
    expect(takeSentences("Suas tarefas abertas são estas\nrevisar Fisiologia\n")).toEqual({
      ready: ["Suas tarefas abertas são estas", "revisar Fisiologia"],
      rest: "",
    });
  });
});

describe("yesOrNo", () => {
  it("understands spoken answers, with or without accents and punctuation", () => {
    for (const yes of ["Sim.", "pode", "Pode sim!", "claro", "ok", "Isso", "manda ver", "com certeza"])
      expect(yesOrNo(yes), yes).toBe(true);
    for (const no of ["Não.", "nao", "Cancela", "agora não", "melhor não", "espera"])
      expect(yesOrNo(no), no).toBe(false);
    for (const unsure of ["talvez", "o quê?", ""]) expect(yesOrNo(unsure), unsure).toBeNull();
  });
});

describe("wakeRequest", () => {
  it("wakes on the ways the speech model writes “Ei, Ani”, keeping the request that follows", () => {
    // Real transcriptions from native/voz (Parakeet Ultra, voice Luciana).
    expect(wakeRequest("Eiane, quantas revisões eu tenho hoje?")).toEqual({
      woke: true,
      rest: "quantas revisões eu tenho hoje?",
    });
    expect(wakeRequest("Oiane, anota a tarefa de ler o capítulo 2.")).toEqual({
      woke: true,
      rest: "anota a tarefa de ler o capítulo 2.",
    });
    expect(wakeRequest("Ani, qual é o próximo tópico do roadmap?")).toEqual({
      woke: true,
      rest: "qual é o próximo tópico do roadmap?",
    });
    expect(wakeRequest("Ei Ani.")).toEqual({ woke: true, rest: "" });
    expect(wakeRequest("Hey Annie")).toEqual({ woke: true, rest: "" });
  });

  it("stays asleep for ordinary speech", () => {
    for (const text of [
      "Hoje eu vi a Ana na faculdade.",
      "Eu acho que sim.",
      "Ana, vem cá",
      "Anime novo saiu",
      "Ei, Antônio",
      "Ei ole ni",
    ]) {
      expect(wakeRequest(text).woke, text).toBe(false);
    }
  });
});
