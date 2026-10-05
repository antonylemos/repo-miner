# Processo do projeto

## O que o projeto faz

Este projeto é uma CLI em TypeScript para descobrir repositórios públicos do GitHub que podem ser relevantes para uma pesquisa sobre composição de frontends e micro-frontends. Ela executa consultas definidas em um catálogo, registra os resultados e sua proveniência, mantém checkpoints para permitir retomadas e exporta arquivos de dados e um relatório de cobertura.

A saída é um conjunto de candidatos para análise posterior. A busca não confirma que um repositório implementa micro-frontends, não classifica sua arquitetura e não mede a prevalência da abordagem. Os totais descrevem os resultados obtidos pelas consultas configuradas.

## Como o código funciona

O caminho principal passa pela CLI em `src/cli/main.ts` e pelos módulos do diretório `src/discovery/`:

1. **Entrada da CLI:** o Commander interpreta `discover` ou `report`, as opções e os pedidos de ajuda. Opções inválidas ou ausentes retornam código de saída `1`.
2. **Validação da descoberta:** `discover` exige `GITHUB_TOKEN`. O catálogo JSON v2 é validado por `catalog.ts`, que calcula seu hash SHA-256. Cada consulta precisa de identificador único, estratégia, endpoint, expressão de busca e justificativa; a partição é opcional.
3. **Expansão:** `expansion.ts` converte cada consulta em subconsultas determinísticas, acrescentando `pushed:>=` (repositórios) e os intervalos de `created:` ou `size:` da partição.
4. **Criação ou retomada do armazenamento:** `storage.ts` cria ou abre `discovery.sqlite`. Uma rodada nova persiste catálogo, hash, recorte, data de expansão e subconsultas. Uma retomada usa exatamente o que foi persistido.
5. **Busca no GitHub:** `github.ts` consulta a busca REST por subconsulta; `http.ts` aplica a política comum (2 s para repositórios, 6 s para código, 1 s para GraphQL, timeout de 30 s, até três tentativas e espera conforme os limites de taxa).
6. **Paginação e checkpoints:** `runner.ts` percorre até dez páginas por subconsulta, salvando cada página e seu checkpoint numa transação. Subconsultas saturadas ou incompletas ficam `partial`; erros recuperáveis ficam `failed`.
7. **Enriquecimento e recorte:** candidatos sem `pushed_at` são enriquecidos por `enrichment.ts` em lotes de 100 pela API GraphQL; `scope.ts` classifica cada candidato pelo recorte temporal.
8. **Encerramento:** uma rodada em que todas as consultas terminaram completamente retorna `0`. Uma rodada incompleta ou parcial retorna `2`. Erros fatais da CLI retornam `1`. Um sinal SIGINT interrompe a busca atual de forma abortável; páginas já confirmadas permanecem disponíveis para retomada.

## Estrutura principal

| Caminho | Responsabilidade |
| --- | --- |
| `src/cli/main.ts` | Comandos, opções, código de saída, início e retomada da descoberta. |
| `src/discovery/catalog.ts` | Validação do catálogo e hash estável de suas consultas. |
| `src/discovery/expansion.ts` | Expansão do catálogo em subconsultas. |
| `src/discovery/http.ts` | Política de rede comum aos clientes REST e GraphQL. |
| `src/discovery/enrichment.ts` | Enriquecimento de metadados pela API GraphQL. |
| `src/discovery/scope.ts` | `pushed_at` efetivo e classificação temporal. |
| `src/discovery/github.ts` | Cliente da API GitHub: paginação, normalização, timeout, espera e tentativas. |
| `src/discovery/runner.ts` | Execução sequencial, persistência de páginas e cálculo dos estados. |
| `src/discovery/storage.ts` | Banco SQLite, consultas, subconsultas, candidatos, hits, enriquecimentos e checkpoints. |
| `src/discovery/report.ts` | Exportação dos arquivos e cálculo das métricas e interseções. |
| `src/discovery/types.ts` | Tipos compartilhados entre catálogo, cliente, executor e armazenamento. |
| `config/discovery.queries.json` | Catálogo de consultas usado como configuração inicial. |
| `tests/` | Testes do catálogo, cliente, executor, armazenamento, relatórios e CLI. |

## Preparar o ambiente

O projeto fixa Node.js `26.9.0` em `.nvmrc` e pnpm `9.15.9` em `package.json`. Com fnm e Corepack disponíveis:

```sh
fnm install
fnm use
corepack enable
pnpm install --frozen-lockfile
pnpm run build
```

O build é necessário antes da primeira execução da CLI: o comando `pnpm run cli` executa `dist/src/cli/main.js`.

## Usar a CLI

### Ver os comandos disponíveis

```sh
pnpm run cli --help
pnpm run cli discover --help
pnpm run cli report --help
```

### Criar uma rodada

As buscas exigem um token do GitHub disponível no ambiente do processo. Configure-o sem colocá-lo no catálogo ou nos arquivos de saída:

```sh
export GITHUB_TOKEN='<token>'
```

Conferir a partição antes de uma rodada. O dry-run expande o catálogo, consulta apenas o total de cada subconsulta e não cria arquivos; retorna `2` se alguma subconsulta passar de 1.000 resultados:

```sh
pnpm run cli discover --queries config/discovery.queries.json --dry-run > dry-run.md
```

Execute o catálogo fornecido e escolha um diretório exclusivo para a rodada:

```sh
pnpm run cli discover \
  --queries config/discovery.queries.json \
  --output data/discovery/rodada-001
```

O catálogo (`version: 2`) declara um recorte global `filters.pushedSince` e, por consulta, `rationale` obrigatório e uma partição opcional:

- `{"by": "created", "from": "2019-01-01", "interval": "month" | "quarter" | "year"}` para `repositories`;
- `{"by": "size", "bounds": [0, 1000, 2000]}` para `code`.

A CLI expande cada consulta em subconsultas com `pushed:>=`, `created:` e `size:` gerados; esses qualificadores não podem ser escritos à mão em `q`. Candidatos encontrados apenas pela busca de código são enriquecidos pela API GraphQL para obter `pushedAt` e metadados de filtragem.

IDs de consulta precisam ser únicos. Para mudar as buscas, edite ou crie outro catálogo e inicie uma rodada nova em outro diretório. A CLI não inicia uma nova rodada num diretório que já contenha `discovery.sqlite`.

### Retomar uma rodada

Se uma rodada foi interrompida ou terminou parcial, use o diretório existente:

```sh
pnpm run cli discover --resume data/discovery/rodada-001
```

A retomada continua pelas subconsultas indicadas nos checkpoints e usa o catálogo e as subconsultas persistidos naquela rodada. Ela exige novamente `GITHUB_TOKEN` e refaz apenas buscas e enriquecimentos pendentes ou com falha. Subconsultas já `complete` ou `partial` não são executadas outra vez nessa mesma rodada; para refazer uma busca parcial ou alterar consultas, inicie uma rodada nova.

### Regenerar os relatórios

Os relatórios podem ser recriados a partir do banco sem token de acesso:

```sh
pnpm run cli report --run data/discovery/rodada-001
```

`report` exige que o diretório contenha `discovery.sqlite`.

## Arquivos produzidos

Todos são gravados no diretório da rodada:

| Arquivo | Conteúdo |
| --- | --- |
| `discovery.sqlite` | Catálogo persistido, subconsultas, páginas, candidatos, hits, enriquecimentos e checkpoints por subconsulta; é a fonte usada para retomada e nova exportação. |
| `candidates.csv` | Um registro por id de repositório, com `scope` (`in_scope`, `out_of_scope_temporal`, `unknown`), `pushed_at` e sua fonte, status de enriquecimento e estratégias que o encontraram. |
| `discovery-hits.csv` | Todas as origens, com consulta, subconsulta, `q` efetivo, endpoint, data de coleta e caminho. |
| `coverage.json` | Recorte temporal e data de expansão da rodada, totais, contagens por `scope` e por estratégia, interseções, status do enriquecimento e cobertura por consulta e por subconsulta. |
| `report.md` | Resumo legível: recorte temporal, cobertura por consulta e subconsultas saturadas ou com falha, contagens por `scope` e por estratégia, interseções, status do enriquecimento e limitações. |
| `manifest.json` | Identificação da rodada, recorte temporal (`pushedSince`), data de expansão, hash do catálogo, versões disponíveis, estado da árvore git (`git.dirty`) e SHA-256 dos arquivos exportados. |

## Códigos de saída

| Código | Significado |
| --- | --- |
| `0` | Ajuda exibida, relatório exportado, dry-run sem subconsulta acima de 1.000 resultados, ou descoberta em que todas as subconsultas terminaram `complete` e nenhum enriquecimento ficou `pending` ou `failed`. |
| `1` | Erro fatal: opções inválidas, token ausente para descoberta, catálogo inválido ou diretório/banco inexistente ou conflitante. |
| `2` | Rodada parcial: subconsulta incompleta, saturada ou com falha recuperável, enriquecimento `pending` ou `failed`, dry-run com subconsulta acima de 1.000 resultados, ou interrupção. |

## Desenvolvimento e verificações

```sh
pnpm run check
pnpm run typecheck
pnpm test
pnpm run build
```

`check` executa as verificações do Biome, `typecheck` verifica os tipos TypeScript, `test` executa a suíte Vitest e `build` compila para `dist/`.

## Limites de interpretação

O GitHub pode alterar a indexação, sinalizar resultados incompletos e limitar a paginação. O executor para após dez páginas por subconsulta e registra a saturação quando o total informado excede mil resultados ou ainda há outra página após a décima. Por isso, os arquivos representam a cobertura observada durante aquela rodada, não um inventário completo do GitHub. Candidatos precisam de triagem humana para confirmar arquitetura, relevância e elegibilidade.
