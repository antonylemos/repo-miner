# repo-miner

CLI em TypeScript para descobrir repositórios públicos do GitHub a partir de um catálogo de consultas, de forma reproduzível e auditável. Para cada repositório encontrado, a ferramenta registra por qual consulta, em que data e por qual caminho ele apareceu, e exporta os resultados em CSV, JSON e Markdown.

A ferramenta não depende de um tema. O tema de um estudo está no catálogo, e o código não sabe nada sobre ele. O mesmo processo serve a qualquer estudo de mineração de repositórios: adoção de uma tecnologia, uso de um padrão arquitetural, presença de uma prática.

**O que a ferramenta faz:** executa buscas no GitHub, recupera integralmente cada consulta particionada, deduplica repositórios sem perder as origens, avalia regras opcionais de elegibilidade (coletando só os fatos que as regras pedem) e documenta a cobertura obtida.

**O que ela não faz:** não confirma que um candidato pertence ao fenômeno pesquisado, não classifica repositórios e não mede prevalência. Os candidatos seguem para triagem humana.

O guia [PROCESS.md](PROCESS.md) descreve, passo a passo e para quem não conhece o projeto, como a mineração acontece e como os dados são tratados.

## Requisitos e instalação

- Node.js 26.9.0, conforme `.nvmrc`.
- pnpm 9.15.9, declarado em `package.json`.
- Um token do GitHub com acesso de leitura a repositórios públicos.

Com fnm e Corepack instalados:

```sh
fnm install
fnm use
corepack enable
pnpm install --frozen-lockfile
pnpm run build
```

Verificações locais:

```sh
pnpm run check
pnpm run typecheck
pnpm test
```

## Credencial do GitHub

As buscas exigem `GITHUB_TOKEN` no ambiente do processo. O token é usado apenas por `discover` e nunca é gravado no banco, nos relatórios ou nas mensagens de erro. `report` e `--help` não precisam dele.

```sh
export GITHUB_TOKEN='<token>'
```

## Uso rápido

```sh
# 1. Conferir o volume de cada subconsulta, sem criar arquivos
pnpm run cli discover --queries <catalogo.json> --dry-run > dry-run.md

# 2. Executar uma rodada num diretório novo
pnpm run cli discover --queries <catalogo.json> --output data/discovery/rodada-001

# 2b. Idem, com regras de elegibilidade (protocolo opcional)
pnpm run cli discover --queries <catalogo.json> --protocol <protocolo.json> --output data/discovery/rodada-001

# 3. Retomar uma rodada interrompida ou parcial
pnpm run cli discover --resume data/discovery/rodada-001

# 4. Regenerar os relatórios a partir do banco, sem token
pnpm run cli report --run data/discovery/rodada-001
```

O dry-run retorna `2` quando alguma subconsulta passa de 1.000 resultados, sinal de que a partição precisa ser refinada antes da rodada. Uma rodada nova não reutiliza um diretório que já contenha `discovery.sqlite`.

As buscas de repositórios e de código executam em paralelo; dentro de cada endpoint, as subconsultas e suas páginas seguem em sequência. Quando há regras de elegibilidade, a coleta dos fatos que elas pedem acontece durante as buscas e ao final.

`report` regenera os arquivos a partir do banco, sem rede nem token, e não altera o estado persistido da rodada: só `discover --resume` recalcula e grava esse estado.

## Catálogo

O catálogo é um arquivo JSON com um único campo, `queries`, que descreve o que buscar e por quê. Exemplo mínimo:

```json
{
  "queries": [
    {
      "id": "terminology-topic-example",
      "strategy": "terminology",
      "endpoint": "repositories",
      "q": "topic:example-term",
      "rationale": "Tópico explícito que nomeia o fenômeno estudado."
    },
    {
      "id": "technology-example-package-code",
      "strategy": "technology",
      "endpoint": "code",
      "q": "\"example-library\" filename:package.json",
      "rationale": "Dependência declarada, independente da terminologia.",
      "partition": { "by": "size", "bounds": [0, 1000, 2000, 4000] }
    }
  ]
}
```

| Campo | Significado |
| --- | --- |
| `id` | Identificador único e estável da consulta. |
| `strategy` | Rótulo livre, escolhido pelo estudo, para o procedimento de descoberta a que a consulta pertence. Aceita letras minúsculas, dígitos e `-` ou `_` internos (`package-manifest`, `readme_terms`). Os relatórios contam e cruzam os rótulos presentes no catálogo, na ordem da primeira ocorrência; não existe um conjunto fixo. |
| `endpoint` | `repositories` (nome, descrição, README e tópicos) ou `code` (conteúdo de arquivos). |
| `q` | Expressão de busca do GitHub, sem `pushed:`, `created:` ou `size:`, que a ferramenta gera. |
| `rationale` | Por que a consulta existe. Obrigatório. |
| `partition` | Opcional. `{"by": "created", "from": "AAAA-MM-01", "interval": "month" \| "quarter" \| "year"}` para `repositories`, ou `{"by": "size", "bounds": [0, …]}` para `code`. |

A API de busca devolve no máximo 1.000 resultados por consulta. A partição divide uma consulta grande em subconsultas menores, para que nenhum resultado seja perdido pelo corte do GitHub. Para mudar o catálogo, crie uma rodada nova; uma rodada sempre usa o catálogo gravado quando foi criada.

O catálogo só lê `queries`; outros campos são ignorados. Para recortar por data de atividade, declare uma regra `last_push` no protocolo (veja abaixo).

## Protocolo de elegibilidade

O protocolo é opcional e fica em um arquivo separado, passado por `--protocol`. Sem protocolo, ou com `"eligibility": []`, a rodada registra um protocolo vazio: todo candidato fica `not_applied`, não há coleta de metadados nem de atividade, e nenhuma subconsulta recebe filtro temporal. As opções `--activity-*` exigem um protocolo com regras e são rejeitadas fora dele, inclusive na retomada de uma rodada que não tem regras.

```json
{
  "eligibility": [
    {
      "id": "recent-human-commit",
      "type": "recent_commit",
      "since": "2025-04-01",
      "dateField": "committedDate",
      "branches": "all",
      "authors": "human"
    }
  ]
}
```

Há dois tipos de regra:

- `recent_commit` procura ao menos um commit com autor humano desde meia-noite UTC inclusiva da data configurada, usando `committedDate`, em qualquer branch existente. A branch padrão tem prioridade operacional. O autor é a referência, independentemente do committer, merges, auto-merges, rebases ou cherry-picks. A janela termina no instante de inspeção persistido para o candidato. Essa regra não acrescenta filtro de push à busca.
- `last_push` compara o último push do repositório com a data configurada e é a forma de recortar a rodada por atividade. Com a regra, a ferramenta acrescenta `pushed:>=<data>` às subconsultas de `repositories` (a data mais recente entre as regras `last_push`), inclusive no dry-run. A busca de código não aceita esse filtro: para candidatos encontrados só por código, sem push conhecido, a ferramenta coleta os metadados do repositório pelo GraphQL e avalia a regra com o push coletado.

O catálogo e o protocolo ficam fixos ao criar a rodada. O que conta como atividade em `last_push`:

- **Push não é commit.** O que conta é quando os commits chegaram ao GitHub, não a data registrada neles.
- **Qualquer branch conta.** Um push em um branch que não é o principal também atualiza a data.
- **"Até hoje" significa até a coleta.** A data é lida quando o repositório aparece na busca ou quando seus metadados são coletados; pushes posteriores à rodada não alteram o resultado dela.
- **Atividade recente não é implementação recente.** Para critérios sobre commits, use `recent_commit`.

A coleta de fatos é dirigida pelas regras que ainda precisam deles. As opções `--activity-max-requests` (20), `--activity-commits-per-page` (30), `--activity-branches-per-page` (100) e `--activity-max-duration-ms` (sem teto por padrão) controlam a operação. Todos os valores são inteiros positivos, e páginas aceitam no máximo 100 itens. Cada tentativa de atividade, inclusive retry, consome o orçamento por candidato/invocação; a duração ativa inclui espera HTTP e retries, sem o tempo parado na fila. Na retomada, os tamanhos de página omitidos herdam os valores da primeira invocação; mudanças explícitas incompatíveis em `--activity-commits-per-page` ou `--activity-branches-per-page` são rejeitadas. Os orçamentos de requisições e duração podem mudar por invocação. Resume registra nova invocação e preserva consumo e checkpoints anteriores; não aceita substituir `--queries` ou `--protocol`.

Limite, falha ou autoria indeterminada produzem `unknown`, nunca reprovação automática. Uma ambiguidade terminal de autor com cobertura completa permite rodada `complete`; trabalho necessário ainda pendente, com erro ou limitado deixa a rodada parcial. A elegibilidade não confirma a presença do fenômeno pesquisado.

Dry-run aceita protocolo e expande o plano de busca, consulta apenas totais e aponta saturação. Ele não coleta commits nem avalia elegibilidade dos candidatos e rejeita opções explícitas de orçamento de atividade.

A execução de descoberta é serializada: apenas um processo ativo pode possuir uma rodada. Há proteção de propriedade dentro do processo; retomadas concorrentes em processos diferentes não são suportadas e exigiriam um lease externo. Execute `discover --resume` somente depois de encerrar o processo anterior.

## Saídas

Cada rodada grava em seu diretório:

| Arquivo | Conteúdo |
| --- | --- |
| `discovery.sqlite` | Fonte de verdade da rodada: catálogo, protocolo, subconsultas, páginas brutas, candidatos, hits, fatos coletados, tarefas, checkpoints e invocações. |
| `candidates.csv` | Um registro por repositório: `id`, `full_name`, `url`, `strategies` (rótulos do catálogo que o encontraram, separados por `;`, na ordem do catálogo) e `metadata_json`, com só os campos de análise da busca (`description`, `topics`, `language`, `license`, `created_at`, `pushed_at`, `size`, `stargazers_count`, `forks_count`, `archived`, `fork`, `default_branch`, `homepage`). Com regras de elegibilidade, acrescenta `eligibility_status`, `eligibility_results_json` e `evidence_json`. |
| `discovery-hits.csv` | Cada ocorrência de um repositório numa subconsulta, com consulta, subconsulta, `q` efetivo, endpoint, data de coleta e caminho do arquivo. |
| `coverage.json` | Totais, contagens e interseções por estratégia (`byStrategy.all`, `intersections.all`) e cobertura por consulta e por subconsulta. Com regras, acrescenta `byEligibility`, `unknownReasons`, `byStrategy.pass`, `intersections.pass` e `collection` (resumo e custo da coleta). |
| `report.md` | Diagnóstico legível: cobertura por consulta, subconsultas que exigem revisão, contagens e interseções por estratégia e limitações. Com regras, inclui as seções de elegibilidade, coleta e custo e refs observadas. |
| `manifest.json` | Identificação da rodada, hashes do catálogo e do protocolo, data de expansão, versões dos avaliadores, ambiente, revisão e estado da árvore git (`git.dirty`) e SHA-256 dos arquivos exportados. |

Sem protocolo (ou com protocolo sem regras), as colunas e seções de elegibilidade não existem, e a rodada não coleta metadados além dos devolvidos pela busca: candidatos encontrados só pela busca de código não trazem `pushed_at`, estrelas ou data de criação. Quem precisa desses metadados, ou de recorte temporal, declara uma regra `last_push`.

Os metadados originais do primeiro encontro e os hits permanecem preservados no banco. Para análise, a ferramenta projeta uma única observação REST de repositório: prefere push válido e, entre observações equivalentes, a menor data de coleta, com desempate por subconsulta e caminho. Todos os campos dessa projeção vêm da mesma observação; sem hit REST, usa o primeiro encontro.

Cada exportação lê uma fotografia consistente do SQLite, incluindo CSV, cobertura e estado da rodada. Durante a coleta, `report` pode exportar enquanto outra conexão grava páginas; novas gravações aparecem na exportação seguinte. Enquanto o banco estiver aberto, podem existir `discovery.sqlite-wal` e `discovery.sqlite-shm`, arquivos auxiliares do modo WAL. Use no máximo um processo de descoberta gravando e um exporter ativo por diretório; evite sobrepor `report` à exportação final de `discover`.

## Códigos de saída

- `0`: ajuda exibida, relatório exportado, dry-run sem subconsulta acima de 1.000 resultados, ou rodada com busca completa e todo trabalho necessário concluído, inclusive quando resta autoria terminal `unknown`.
- `1`: erro fatal, como opções ou catálogo inválidos, token ausente, diretório ou banco inexistente ou conflitante, banco de formato incompatível, ou falha de requisição no dry-run.
- `2`: rodada parcial (subconsulta saturada, incompleta ou com falha, coleta ainda necessária pendente, com falha ou limitada por orçamento, interrupção) ou dry-run com subconsulta acima de 1.000 resultados.

## Limitações

- A busca depende da indexação do GitHub, que pode mudar durante a rodada e marcar resultados como incompletos. Os totais descrevem as consultas executadas, não a população de repositórios.
- As APIs de busca excluem forks por padrão.
- A busca de código considera apenas a branch padrão e arquivos de até 384 KB, e não aceita filtros de data. Para recortar esses candidatos por data, declare uma regra `last_push`: a ferramenta coleta os metadados de que ela precisa.
- Contagens não são prevalência nem casos confirmados. Pertinência, classificação e elegibilidade ficam para a triagem humana.

## Caso de uso: micro-frontends

O catálogo [`config/catalogs/micro-frontends.json`](config/catalogs/micro-frontends.json) foi construído para o estudo *What Do Micro-Frontends Look Like in Software Repositories?*, que caracteriza como implementações de micro-frontends (MFEs) aparecem em repositórios. A descoberta produz o conjunto de candidatos que depois passa por triagem e classificação (*MFE-implemented*, *Non-MFE* ou *Uncertain*).

**As três estratégias deste estudo** (28 consultas). Os rótulos `terminology`, `technology` e `broader` são escolha do estudo, declarados no catálogo, e não um vocabulário da ferramenta:

| Estratégia | Consultas | Exemplos |
| --- | ---: | --- |
| `terminology` | 8 | `topic:microfrontends`; `"micro frontend" in:name,description,readme` |
| `technology` | 15 | Module Federation (`topic:module-federation`, `ModuleFederationPlugin remotes extension:js`, plugins Vite e Angular), single-spa (`"single-spa" filename:package.json`) e Web Components |
| `broader` | 5 | `"frontend composition"`, `"frontend orchestration"`, `"micro apps" frontend` |

**Decisões do estudo:**

- **Protocolo de atividade** ([`config/protocols/micro-frontends.json`](config/protocols/micro-frontends.json)): exige commit de autor humano com `committedDate` desde 01/04/2025 em qualquer branch existente. O catálogo mantém as mesmas 28 consultas. O critério não data a introdução da arquitetura MFE.
- **Partições:** termos MFE e `"module federation"` são particionados por mês de criação, porque cada termo soma entre 8 e 13 mil repositórios ativos. Consultas de código são particionadas por tamanho de arquivo, porque a busca de código não aceita datas.
- **Termos com hífen entre aspas:** sem aspas, `single-spa` é lido como "single" e "spa" (356 mil resultados contra 6 mil com aspas).
- **Tecnologias fixadas:** a estratégia `technology` cobre apenas Module Federation, single-spa e Web Components. Frameworks como qiankun, wujie, micro-app e Piral ficam de fora; repositórios que os usam e se descrevem como MFE ainda chegam pela terminologia.
- **Consultas de tecnologia sobre artefatos** (`package.json`, configurações com `remotes`, `registerApplication`), e não sobre prosa, para encontrar repositórios que usam a tecnologia sem se descrever como MFE.
- **Risco conhecido:** Web Components não tem um artefato que distinga uso como MFE de uma biblioteca de componentes. As duas consultas dessa abordagem exigem que o README também mencione micro-frontends, grafado como `"micro frontends"` ou `microfrontends`; os demais casos devem chegar pela terminologia e ser identificados na triagem.

**Execução:**

```sh
pnpm run cli discover --queries config/catalogs/micro-frontends.json --protocol config/protocols/micro-frontends.json --dry-run > dry-run.md
pnpm run cli discover --queries config/catalogs/micro-frontends.json --protocol config/protocols/micro-frontends.json --output data/discovery/mfe-rodada-001
```

O [PROCESS.md](PROCESS.md) acompanha uma consulta deste catálogo do início ao fim.
