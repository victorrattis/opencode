---
name: llm-audit-analysis
description: Analisar o que o plugin llm-audit gravou — custo, erros, comportamento do agente — e propor melhorias nos prompts do usuário
---

# Análise da auditoria do llm-audit

O plugin [`.opencode/plugins/llm-audit.ts`](../../plugins/llm-audit.ts) grava um registro por
requisição ao modelo. Esta skill lê esses registros e responde três perguntas: **onde foi o
dinheiro**, **o que quebrou**, e **quais dos seus prompts saíram caros e por quê**.

Use quando pedirem para analisar uma sessão, entender um custo, investigar erros repetidos, ou
melhorar a forma como se pede as coisas ao agente.

## Regra que não se quebra

**Nunca leia um `turn_NNN.json` para "dar uma olhada".** Cada um tem cerca de 1 MB porque carrega o
prompt inteiro; uma sessão são centenas de megabytes. Rode o `analyze.ts`, que agrega e devolve
alguns KB. Ele já abre, sozinho e com critério, os poucos turnos que valem a pena.

O diretório de auditoria é **somente leitura** e é material sensível: os corpos contêm a conversa
inteira, com system prompt, histórico e todo resultado de tool. Não escreva nada dentro dele, não
copie trechos para lugar nenhum sem necessidade.

## Como rodar

Sempre comece listando:

```bash
bun .opencode/skills/llm-audit-analysis/analyze.ts --list
```

Depois a sessão que interessa:

```bash
bun .opencode/skills/llm-audit-analysis/analyze.ts --session 20260902_141819
bun .opencode/skills/llm-audit-analysis/analyze.ts --last 3
bun .opencode/skills/llm-audit-analysis/analyze.ts --session all --json
```

`--session` aceita o nome da pasta, um pedaço dele, o id da sessão, `latest` ou `all`. `--top N`
controla o tamanho dos rankings, `--json` dá a mesma estrutura em JSON, `--out <arquivo>` grava fora
do diretório de auditoria.

Ele descobre o diretório sozinho: `--dir`, `$OPENCODE_LLM_AUDIT_DIR`, `$CLAUDE_LLM_AUDIT_DIR`,
`~/.local/share/opencode/log/llm-audit`, `~/.local/share/claude-code/log/llm-audit` — nessa ordem, e
o cabeçalho da saída diz qual foi.

## O que cada seção significa

**1. Custo e volume.** `resent_tokens` contra o prompt é a razão que importa: quanto da conta é
histórico viajando de novo em vez de coisa nova sendo dita. Em sessão longa passa de 80%, e é normal
— o que se controla é o tamanho do que viaja, não o fato de viajar. A divisão
system/tools/mensagens diz o que cortar: `tools` alto é catálogo de ferramentas grande demais,
`system` alto é AGENTS.md/CLAUDE.md inchado, `mensagens` alto é resultado de tool que voltou grande.

**2. Suas requisições, por custo.** Uma linha por coisa que você digitou, com o que ela custou. É a
tabela central: liga _o que foi pedido_ a _o que aquilo cobrou_. Um pedido com 90 turnos e um com 4
não são o mesmo tipo de pedido.

**3. Erros e desperdício.** Retry é token pago duas vezes e é desperdício puro. `max_tokens` é
resposta **truncada** — o resultado está incompleto, não apenas caro. Compactação por `overflow` é
limite de contexto batido, não escolha. Erro de tool repetido com a mesma mensagem não é azar: é
assinatura de ferramenta sendo usada errado, e quase sempre tem conserto no prompt ou no AGENTS.md.

**4. Cache.** Aqui mora a armadilha. `prefix_stable: false` em quase todo turno **não é sempre culpa
sua**. Olhe a coluna "o que mudou":

- se for um cabeçalho do próprio cliente (`x-anthropic-billing-header`, `cc_prev_req=...`), isso muda
  a cada requisição por construção — não há nada a fazer, e o hit rate alto ao lado prova que o
  provider ainda acertou o cache. **Diga isso, e não invente recomendação;**
- se for uma mensagem do histórico, ou `tools_changed: true` no meio da sessão, aí sim algo do lado
  controlável mexeu no prefixo, e cada quebra dessas custa o histórico inteiro em preço cheio.

**5. Comportamento do agente.** Média de turnos por requisição diz se os pedidos estão grandes demais.
Os pares consecutivos mostram a trajetória: muito `Bash -> Bash` é tentativa e erro; muito
`Read -> Read` sem `Edit` é procura por algo que o prompt não apontou. Chamadas idênticas repetidas
são trabalho refeito.

**6. Os prompts, na íntegra.** A matéria-prima da próxima seção.

## Como propor melhorias nos prompts

Este é o entregável que o usuário mais quer. Trabalhe sobre a seção 6 cruzada com a 2 e a 3, e
procure sinais concretos — não impressões:

| sinal nos dados                                                                                                             | o que quer dizer                                                                  | como reescrever                                                                               |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| requisição seguida em poucos turnos por outra que corrige ("na verdade", "não é isso", "esqueci de dizer", "remove aquilo") | o primeiro prompt estava incompleto e você pagou uma ida ao modelo para descobrir | juntar os dois num pedido só, com a correção já dentro                                        |
| muitos `Read`/`Grep`/`Glob` antes do primeiro `Edit`                                                                        | faltou dizer **onde**                                                             | citar o arquivo, e a função ou a seção                                                        |
| erros de tool repetidos dentro da mesma requisição                                                                          | faltou o comando certo, o caminho certo ou a versão certa                         | passar o comando que funciona, ou registrá-lo no AGENTS.md para não repetir o pedido toda vez |
| muitos turnos e pouca saída                                                                                                 | escopo largo demais para um pedido só                                             | quebrar em pedidos com entrega verificável cada um                                            |
| nenhuma forma de saber que terminou                                                                                         | trajetória sem critério de parada                                                 | dizer como se verifica: o teste que passa, o comando que roda, a tela que aparece             |
| `max_tokens`                                                                                                                | pediu-se mais saída do que cabe numa resposta                                     | pedir em partes, ou pedir arquivo em vez de texto na conversa                                 |

Entregue como tabela **prompt original → problema → reescrita sugerida**, com a reescrita pronta para
copiar e colar. Uma reescrita que não cabe num prompt real não serve.

Se um prompt está bom, diga que está bom. Inventar problema em cima de pedido que funcionou custa a
confiança no resto do relatório.

## O relatório final

1. **Números** — custo, turnos, requisições, cache, em quatro ou cinco linhas.
2. **Achados, ordenados por impacto** — cada um com evidência: turno, requisição, número. Um achado
   sem evidência no digest não entra.
3. **Reescritas de prompt** — a tabela acima.
4. **Recomendações de configuração**, quando os dados sustentarem: o que cortar do AGENTS.md, quais
   tools desligar (`"tools": { "x": false }` no `opencode.jsonc`), qual tool devolve resultado grande
   demais.
5. **Ressalvas** — copie da seção 7 do digest as que valerem.

## Ressalvas que o relatório precisa repetir

- Tokens por parte (system/tools/mensagens) são o total do provider **distribuído por caracteres**:
  exatos no agregado, aproximados por linha, e sem sentido em linha marcada `binary` (imagem, áudio).
- `request_match: "adjacent"` é casamento por proximidade, não exato. No lado Claude Code é o caso
  comum, porque join exato entre requisição e resposta não existe ali.
- `usage.source: "estimated"` é palpite de chars/4, não conta do provider. Nunca some os dois como se
  fossem a mesma coisa.
- Um contador ausente **não é zero**: o plugin omite o que o dialeto não reporta, justamente para não
  confundir "não tem cache" com "o cache errou".
- Erros de tool saem dos corpos que o script abriu (primeiro e último turno de cada requisição). É a
  conversa quase inteira, mas depois de uma compactação o que foi descartado não está mais lá.
- O lado opencode traz `tools.jsonl` com duração e falha de cada execução; o lado Claude Code não tem
  esse arquivo, e ali as falhas vêm dos `tool_result` marcados com erro. Não compare os dois números
  como se fossem medidos do mesmo jeito.
