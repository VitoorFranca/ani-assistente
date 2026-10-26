import { describe, expect, it } from "vitest";
import { numberWords, spokenText } from "../src/main/spoken.js";

describe("numberWords", () => {
  it("says numbers the way people do", () => {
    expect(numberWords(0)).toBe("zero");
    expect(numberWords(21)).toBe("vinte e um");
    expect(numberWords(100)).toBe("cem");
    expect(numberWords(115)).toBe("cento e quinze");
    expect(numberWords(1000)).toBe("mil");
    expect(numberWords(1500)).toBe("mil e quinhentos");
    expect(numberWords(1203)).toBe("mil duzentos e três");
    expect(numberWords(20000)).toBe("vinte mil");
    expect(numberWords(150020)).toBe("cento e cinquenta mil e vinte");
  });
});

describe("spokenText", () => {
  it("turns digits, percentages and decimals into words", () => {
    expect(spokenText("Você tem 12 cartões e acertou 85% ontem.")).toBe(
      "Você tem doze cartões e acertou oitenta e cinco por cento ontem.",
    );
    expect(spokenText("cerca de 20 mil tokens, uns 4,5% da janela")).toBe(
      "cerca de vinte mil tokens, uns quatro vírgula cinco por cento da janela",
    );
    expect(spokenText("1.500 cartões")).toBe("mil e quinhentos cartões");
  });

  it("replaces the pauses the voices skip and drops markdown", () => {
    expect(spokenText("O roadmap tem **oito** tópicos; o próximo é `SQL`.")).toBe(
      "O roadmap tem oito tópicos, o próximo é SQL.",
    );
    expect(spokenText("- primeiro\n- segundo")).toBe("primeiro segundo");
  });

  it("leaves numbers it cannot say alone", () => {
    expect(spokenText("versão 2026123")).toBe("versão 2026123");
  });
});
