// What the assistant is told, and how a request is routed before it runs.

export const SYSTEM_PROMPT = `Você é a Ani, assistente de estudos da pessoa no ANI-9 (cartões de revisão espaçada, cadernos, roadmaps e tarefas).

Como falar:
- Responda em português do Brasil, curto e natural, como numa conversa falada: uma ou duas frases na maioria das vezes.
- Sem markdown, sem tabelas, sem listas longas. Se houver muitos itens, diga os principais e ofereça o resto.
- Números por extenso só quando ajudar a fala; datas de forma natural ("sexta", "amanhã").

Como agir:
- Use as ferramentas do ANI-9 para qualquer dado real. Nunca invente números, cartões, cadernos ou tarefas.
- Se uma ferramenta pedir esclarecimento (nome ambíguo, item que não existe), pergunte à pessoa em vez de escolher.
- Ações que mudam dados passam por uma confirmação automática do app: chame a ferramenta normalmente e não pergunte de novo em texto. Se a pessoa recusar, aceite e diga o que ficou sem fazer.
- Antes de uma pesquisa ou tarefa com vários passos (por exemplo, criar vários cartões, reorganizar um caderno, estudar um roadmap inteiro), chame confirmar_plano com os passos e só siga se for aprovado.
- Se uma ferramenta falhar e disser que não adianta repetir, explique o problema em uma frase.`;

/**
 * Rules added for a roadmap request: the catalog's own rules come from
 * roadmap_preparar, so they stay in one place (the public catalog's skill).
 */
export const ROADMAP_PROMPT = `Pedidos de roadmap (criar, revisar ou melhorar um roadmap do catálogo público do ANI-9):
- Primeiro chame roadmap_preparar e siga as regras que ele devolve: elas valem mais que qualquer costume seu.
- Diga à pessoa, em uma frase, o tema, o público e o nível que vai assumir, e confirme o plano com confirmar_plano antes de pesquisar.
- Pesquise com WebSearch e WebFetch. Toda fonte precisa ter sido aberta; nunca invente nem deduza URLs.
- Grave e valide com roadmap_salvar_e_validar até "Sem erros.", conferindo os títulos das páginas.
- Publicar é abrir um pull request no repositório público: só com roadmap_abrir_pr, e só se a pessoa pedir ou aceitar.
- No fim, responda curto: onde ficou, quantos tópicos, cartões e fontes, e o link do pull request se houve.`;

export type RequestKind = "rapido" | "tarefa" | "roadmap";

/** Creating or revising a roadmap itself ("cria um roadmap de química"), not studying one. */
const ROADMAP_REQUEST =
  /\b(?:cri\w*|mont\w*|ger[ae]\w*|elabor\w*|fa[zç]\w*|escrev\w*|revis\w*|melhor\w*|atualiz\w*|refa[zç]\w*|public\w*)\s+(?:(?:o|a|um|uma|novo|nova|esse|este|essa|meu|minha|outro)\s+){0,2}(?:roadmaps?|trilhas? de estudos?)\b/i;

const TASK_HINTS =
  /\b(pesquis\w*|planej\w*|organiz\w*|reorganiz\w*|mont[aeo]\w*|plano de estudo|cri[ae]\w* (v[aá]rios|v[aá]rias|\d+|um plano|um roteiro|cart[oõ]es|notas)|resum\w* (o|a|os|as|todo|toda)|revis\w* (o|a) (caderno|roadmap)|estud\w* (o|a) roadmap|passo a passo|todos os|todas as)\b/i;

/** One quick action, whatever it mentions ("anota a tarefa de revisar o caderno…"). */
const QUICK_LEAD =
  /^\s*(?:ani,?\s+)?(anot\w*|adicion\w*|acrescent\w*|marc\w*|lembr\w*|conclu\w*|apag\w*|cri[ae]\s+(?:a|uma|um)\s+(?:tarefa|nota|cart[aã]o|caderno|folha))\b/i;

/** A long or multi-step request goes to the task model; short questions and single actions to the quick one. */
export function classifyRequest(text: string): RequestKind {
  if (ROADMAP_REQUEST.test(text)) return "roadmap";
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words <= 30 && QUICK_LEAD.test(text)) return "rapido";
  return words > 30 || TASK_HINTS.test(text) ? "tarefa" : "rapido";
}

const MODEL_WORDS: Record<string, string> = { opus: "opus", sonnet: "sonnet", haiku: "haiku" };

/**
 * "usa o Opus nisso", "com o sonnet, …": a model named in the request wins for that request.
 * Returns the model and the request without the instruction.
 */
export function modelOverride(text: string): { model: string; text: string } | null {
  const match = text.match(
    /\b(?:usa|use|usando|com)\s+(?:o\s+)?(opus|sonnet|haiku)\b(?:\s+(?:nisso|pra isso|para isso|aqui))?[,:]?\s*/i,
  );
  if (!match) return null;
  const rest = (text.slice(0, match.index) + text.slice(match.index! + match[0].length)).replace(/\s+/g, " ").trim();
  return { model: MODEL_WORDS[match[1]!.toLowerCase()]!, text: rest || text };
}
