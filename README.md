# repo-miner

CLI em TypeScript para descobrir repositórios públicos do GitHub a partir de um catálogo versionado de consultas, de forma reproduzível e auditável. Para cada repositório encontrado, a ferramenta registra por qual consulta, em que data e por qual caminho ele apareceu, e exporta os resultados em CSV, JSON e Markdown.

A ferramenta não depende de um tema. O tema de um estudo está no catálogo, e o código não sabe nada sobre ele. O mesmo processo serve a qualquer estudo de mineração de repositórios: adoção de uma tecnologia, uso de um padrão arquitetural, presença de uma prática.

**O que a ferramenta faz:** executa buscas no GitHub, recupera integralmente cada consulta particionada, deduplica repositórios sem perder as origens, completa metadados, aplica um recorte por atividade recente e documenta a cobertura obtida.

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

# 3. Retomar uma rodada interrompida ou parcial
pnpm run cli discover --resume data/discovery/rodada-001

# 4. Regenerar os relatórios a partir do banco, sem token
pnpm run cli report --run data/discovery/rodada-001
```

O dry-run retorna `2` quando alguma subconsulta passa de 1.000 resultados, sinal de que a partição precisa ser refinada antes da rodada. Uma rodada nova não reutiliza um diretório que já contenha `discovery.sqlite`. Rodadas existentes no formato SQLite v2 continuam aceitas; formatos anteriores já incompatíveis continuam rejeitados.

As buscas de repositórios e de código executam em paralelo; dentro de cada endpoint, as subconsultas e suas páginas seguem em sequência. O enriquecimento GraphQL processa lotes completos durante as buscas e os candidatos restantes ao final.

`report` recupera a análise de uma rodada v2 a partir dos hits REST já gravados, sem rede nem token. Ele regenera os arquivos, mas conserva o estado persistido da rodada: só `discover --resume` recalcula e grava esse estado. Erros antigos que não foram armazenados não podem ser reconstruídos; um enriquecimento antigo `ok` com push nulo não ganha um erro inventado nem é reenviado automaticamente.

## Catálogo

O catálogo é um arquivo JSON que descreve o que buscar e por quê. Exemplo mínimo:

```json
{
  "version": 2,
  "filters": { "pushedSince": "2024-01-01" },
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
| `filters.pushedSince` | Recorte por atividade: só entram repositórios cujo **último push** ao GitHub ocorreu nessa data ou depois, até o momento da coleta. Veja [O que conta como atividade](#o-que-conta-como-atividade). |
| `id` | Identificador único e estável da consulta. |
| `strategy` | Procedimento de descoberta: `terminology` (termos que nomeiam o fenômeno), `technology` (tecnologias ou artefatos associados a ele) ou `broader` (termos amplos ou adjacentes, para reduzir viés de terminologia). |
| `endpoint` | `repositories` (nome, descrição, README e tópicos) ou `code` (conteúdo de arquivos). |
| `q` | Expressão de busca do GitHub, sem `pushed:`, `created:` ou `size:`, que a ferramenta gera. |
| `rationale` | Por que a consulta existe. Obrigatório. |
| `partition` | Opcional. `{"by": "created", "from": "AAAA-MM-01", "interval": "month" \| "quarter" \| "year"}` para `repositories`, ou `{"by": "size", "bounds": [0, …]}` para `code`. |

A API de busca devolve no máximo 1.000 resultados por consulta. A partição divide uma consulta grande em subconsultas menores, para que nenhum resultado seja perdido pelo corte do GitHub. Para mudar o catálogo, crie uma rodada nova; uma rodada sempre usa o catálogo gravado quando foi criada.

### O que conta como atividade

O recorte compara a data do **último push** do repositório (`pushed_at`, informada pelo GitHub) com `pushedSince`. Com `pushedSince: 2025-04-01`, um repositório entra quando recebeu algum push entre 01/04/2025 e o momento em que a ferramenta leu essa data. Na prática:

- **Push não é commit.** O que conta é quando os commits chegaram ao GitHub, não a data registrada neles. Commits criados em março de 2025 e enviados em abril contam como atividade em abril.
- **Qualquer branch conta.** Um push em um branch que não é o principal também atualiza a data, mesmo que o branch principal esteja parado.
- **"Até hoje" significa até a coleta.** A data é lida quando o repositório aparece na busca ou quando seus metadados são completados; a coluna `pushed_at_observed_at` registra esse momento. Pushes posteriores à rodada não alteram o resultado dela.
- **Atividade recente não é implementação recente.** Um repositório cuja estrutura foi criada anos antes e que recebeu apenas um ajuste recente entra no recorte. Se o estudo precisar de commits recentes no branch principal, esse é outro critério, que a ferramenta não aplica hoje.

## Saídas

Cada rodada grava em seu diretório:

| Arquivo | Conteúdo |
| --- | --- |
| `discovery.sqlite` | Fonte de verdade da rodada: catálogo, subconsultas, páginas brutas, candidatos, hits, enriquecimentos e checkpoints. |
| `candidates.csv` | Um registro por repositório, com `scope` (`in_scope`, `out_of_scope_temporal`, `unknown`), `pushed_at`, sua fonte, a data em que foi observado (`pushed_at_observed_at`), status de enriquecimento e estratégias que o encontraram. O `metadata_json` traz só os campos de análise da busca (`description`, `topics`, `language`, `license`, `created_at`, `pushed_at`, `size`, `stargazers_count`, `forks_count`, `archived`, `fork`, `default_branch`, `homepage`); os metadados completos ficam no `discovery.sqlite`. |
| `discovery-hits.csv` | Cada ocorrência de um repositório numa subconsulta, com consulta, subconsulta, `q` efetivo, endpoint, data de coleta e caminho do arquivo. |
| `coverage.json` | Cobertura por consulta e por subconsulta, contagens por `scope` e por estratégia, interseções entre estratégias e status do enriquecimento. |
| `report.md` | Diagnóstico legível da rodada, incluindo subconsultas saturadas e limitações. |
| `manifest.json` | Identificação da rodada, recorte, data de expansão, hash do catálogo, versões, revisão e estado da árvore git (`git.dirty`) e SHA-256 dos arquivos exportados. |

Os metadados originais do primeiro encontro e os hits permanecem preservados no banco. Para análise, a ferramenta projeta uma única observação REST de repositório: prefere push válido e, entre observações equivalentes, a menor data de coleta, com desempate por subconsulta e caminho. Todos os campos dessa projeção vêm da mesma observação; sem hit REST, usa o primeiro encontro. `pushed_at_observed_at` indica quando a fonte efetiva do push foi coletada, que pode diferir de `first_seen_at`.

Um push válido de enriquecimento GraphQL `ok` tem precedência sobre REST, mesmo se foi observado antes. Se for nulo ou inválido, vale o push válido da busca; sem data válida, o recorte é `unknown`. Nulo legítimo num nó GraphQL válido e sem erro continua `ok`. Erros parciais afetam o nó associado, preservando irmãos sem erro; erros sem caminho confiável afetam todo o lote. `NOT_FOUND` só é definitivo quando o nó está ausente e o erro aponta diretamente para ele, não para um campo. Os motivos de erro são sanitizados para ocultar a credencial.

`coverage.json.enrichment` e `candidates.csv.enrichment_status` conservam os estados históricos registrados. `enrichmentRequired` conta `pending` e `failed` ainda necessários; `enrichmentSuperseded` conta esses estados dispensados por um push REST válido. Uma falha histórica dispensada permanece auditável e não exige nova chamada GraphQL nem impede a conclusão.

Cada exportação lê uma fotografia consistente do SQLite, incluindo CSV, cobertura e estado da rodada. Durante a coleta, `report` pode exportar enquanto outra conexão grava páginas; novas gravações aparecem na exportação seguinte. Enquanto o banco estiver aberto, podem existir `discovery.sqlite-wal` e `discovery.sqlite-shm`, arquivos auxiliares do modo WAL. Use no máximo um processo de descoberta gravando e um exporter ativo por diretório; evite sobrepor `report` à exportação final de `discover`.

## Códigos de saída

- `0`: ajuda exibida, relatório exportado, dry-run sem subconsulta acima de 1.000 resultados, ou rodada em que todas as subconsultas terminaram `complete` e nenhum enriquecimento ainda necessário ficou `pending` ou `failed`.
- `1`: erro fatal, como opções ou catálogo inválidos, token ausente, diretório ou banco inexistente ou conflitante, banco de formato anterior, ou falha de requisição no dry-run.
- `2`: rodada parcial (subconsulta saturada, incompleta ou com falha, enriquecimento ainda necessário pendente ou com falha, interrupção) ou dry-run com subconsulta acima de 1.000 resultados.

## Limitações

- A busca depende da indexação do GitHub, que pode mudar durante a rodada e marcar resultados como incompletos. Os totais descrevem as consultas executadas, não a população de repositórios.
- As APIs de busca excluem forks por padrão.
- A busca de código considera apenas a branch padrão e arquivos de até 384 KB, e não aceita filtros de data. O recorte temporal desses candidatos depende do enriquecimento.
- Contagens não são prevalência nem casos confirmados. Pertinência, classificação e elegibilidade ficam para a triagem humana.

## Caso de uso: micro-frontends

O catálogo [`config/catalogs/micro-frontends.json`](config/catalogs/micro-frontends.json) foi construído para o estudo *What Do Micro-Frontends Look Like in Software Repositories?*, que caracteriza como implementações de micro-frontends (MFEs) aparecem em repositórios. A descoberta produz o conjunto de candidatos que depois passa por triagem e classificação (*MFE-implemented*, *Non-MFE* ou *Uncertain*).

**As três estratégias neste estudo** (28 consultas):

| Estratégia | Consultas | Exemplos |
| --- | ---: | --- |
| `terminology` | 8 | `topic:microfrontends`; `"micro frontend" in:name,description,readme` |
| `technology` | 15 | Module Federation (`topic:module-federation`, `ModuleFederationPlugin remotes extension:js`, plugins Vite e Angular), single-spa (`"single-spa" filename:package.json`) e Web Components |
| `broader` | 5 | `"frontend composition"`, `"frontend orchestration"`, `"micro apps" frontend` |

**Decisões do estudo:**

- **Recorte por atividade** (`pushedSince: 2025-04-01`): prioriza repositórios com algum push nos 18 meses entre 01/04/2025 e a data da coleta, sem excluir projetos antigos que continuam mantidos. O critério é o último push, não a data dos commits nem a data em que a arquitetura MFE foi introduzida (veja [O que conta como atividade](#o-que-conta-como-atividade)).
- **Partições:** termos MFE e `"module federation"` são particionados por mês de criação, porque cada termo soma entre 8 e 13 mil repositórios ativos. Consultas de código são particionadas por tamanho de arquivo, porque a busca de código não aceita datas.
- **Termos com hífen entre aspas:** sem aspas, `single-spa` é lido como "single" e "spa" (356 mil resultados contra 6 mil com aspas).
- **Tecnologias fixadas:** a estratégia `technology` cobre apenas Module Federation, single-spa e Web Components. Frameworks como qiankun, wujie, micro-app e Piral ficam de fora; repositórios que os usam e se descrevem como MFE ainda chegam pela terminologia.
- **Consultas de tecnologia sobre artefatos** (`package.json`, configurações com `remotes`, `registerApplication`), e não sobre prosa, para encontrar repositórios que usam a tecnologia sem se descrever como MFE.
- **Risco conhecido:** Web Components não tem um artefato que distinga uso como MFE de uma biblioteca de componentes. As duas consultas dessa abordagem exigem que o README também mencione micro-frontends, grafado como `"micro frontends"` ou `microfrontends`; os demais casos devem chegar pela terminologia e ser identificados na triagem.

**Execução:**

```sh
pnpm run cli discover --queries config/catalogs/micro-frontends.json --dry-run > dry-run.md
pnpm run cli discover --queries config/catalogs/micro-frontends.json --output data/discovery/mfe-rodada-001
```

O [PROCESS.md](PROCESS.md) acompanha uma consulta deste catálogo do início ao fim.
