/**
 * Decide se a resposta do paciente ao pos-consulta e POSITIVA o bastante para
 * receber o pedido de indicacao logo em seguida.
 *
 * O pedido comeca com "Ficamos muito felizes em saber que voce esta se sentindo
 * bem!". Mandar isso para quem acabou de relatar dor, pedir a nota fiscal ou
 * desmarcar a consulta seria constrangedor para a clinica. Entao o criterio e
 * deliberadamente CONSERVADOR: na duvida, nao manda. Perder alcance custa pouco;
 * soar surdo custa caro.
 *
 * Calibrado contra as respostas reais ao pos-consulta e endurecido depois de uma
 * revisao adversarial (22/ago/2026) que encontrou estes furos, todos com caso
 * real no banco:
 *   - negacao passando como elogio ("Nao me sinto bem", "Nao gostei do atendimento")
 *   - "tudo bem" de saudacao lido como estado de saude ("Bom dia tudo bem! nao
 *     vou conseguir comparecer hoje")
 *   - cancelamento lido como positivo ("Tudo bem, mas nao vou conseguir ir amanha")
 *   - ressalva ignorada ("Tudo otimo, apenas o ombro pesado")
 *   - "de novo" casando com \bnovo\b ("Preciso desmarcar de novo")
 *   - pedido no imperativo sem "?" ("Quando puder me envia a nota fiscal")
 *   - 'dor' sem \b casando dentro de "adorei", e "sem dor" sendo lido como queixa
 */

/** Remove acentos e baixa a caixa, para comparar sem depender de digitacao. */
function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // "bemmm" -> "bem", "Oieeeee" -> "oie": 3+ letras repetidas sao enfase
    .replace(/(.)\1{2,}/g, '$1');
}

/** Saudacoes e formulas de cortesia nao dizem nada sobre como o paciente esta. */
const SAUDACOES = /\b(bom dia|boa tarde|boa noite|ola|oi+e*|opa|e ai|blz)\b/g;

/**
 * "tudo bem" no comeco da mensagem e cumprimento, nao diagnostico. Caso real:
 * "Bom dia tudo bem! ... nao vou conseguir comparecer hoje".
 */
const CUMPRIMENTO_TUDO_BEM = /^[\s,!.]*tudo (bem|bom|certo|certinho)\b[\s,!.]*/;

/** Dor negada nao e queixa - tirar antes de procurar sintoma. */
const DOR_NEGADA = /\b(sem|nenhuma|zero)\s+dor\w*|\bnao\s+(sinto|senti|tenho|tive)\s+(mais\s+)?dor\w*|\bdor\s+nenhuma\b/g;

/** Sintoma, piora ou queixa. Boundary a esquerda para 'dor' nao casar em 'adorei'. */
const QUEIXA = new RegExp(
  [
    'dor', 'doi', 'doe', 'doendo', 'doeu', 'dolorid', 'doloros',
    'incomod', 'desconforto', 'piora', 'piorou', 'pior', 'ruim',
    'travad', 'travou', 'inchad', 'incha', 'inflam', 'formigament',
    'tontura', 'tonto', 'enjoo', 'nausea', 'machuc', 'latej',
    'ardenc', 'queima', 'rigid', 'limitad', 'tens[ao]', 'crise',
    'espasmo', 'caibra', 'contratur', 'fisgada', 'pontada',
    'nao consegui', 'nao melhor', 'nao passou', 'sem melhora',
    'voltou a doer', 'recaida', 'dificuldade', 'sintoma', 'remedio',
    'analgesic', 'anti-inflamat', 'pesad', 'resquici', 'sensibilidade',
    'cirurgia', 'lesao', 'estalo',
  ]
    .map((t) => '\\b' + t)
    .join('|'),
  'i',
);

/** Melhora parcial e honesta nao merece um texto que pressupoe plena satisfacao. */
const MEIO_TERMO = /\bum pouco\b|\bmais ou menos\b|\baos poucos\b|\brazoave|\bmeio termo\b|\bnem tanto\b|\bdevagar\b|\bpouquinho\b|\bquase\b|\bparcial/i;

/**
 * Marcador de ressalva: o paciente esta bem "mas" alguma coisa. Caso real:
 * "Tudo otimo, apenas o ombro pesado". "ainda bem" e excecao, e elogio.
 */
const RESSALVA = /\bainda\b|\bapenas\b|\bmas\b|\bporem\b|\bso que\b|\btirando\b|\bexceto\b|\bfora (isso|que)\b/i;

/** Assunto de agenda: cancelar, remarcar, faltar. Nunca e hora de pedir favor. */
const AGENDA = /\bcancel|\bdesmarc|\bremarc|\breagend|\badiar\b|\bimprevisto\b|\bnao vou (poder|conseguir)|\bnao (posso|consigo|poderei)\b|\bvou faltar\b|\bnao vou\b/i;

/** Pedido ou pergunta, mesmo sem "?": o paciente espera algo de nos. */
const PEDIDO = /\b(qual|quando|quanto|onde|como|por ?que|pq|quem)\b|\bme (diga|dizer|envia|enviar|manda|mandar|passa|passar|informa|informar|mostra|mostrar)\b|\bficou de\b|\bfico no aguardo\b|\baguardo\b|\bgostaria\b|\bpor (favor|gentileza)\b|\bquando puder\b|\bnota fiscal\b|\brelatorio\b|\brecibo\b|\batestado\b|\blaudo\b|\bagendar\b|\bpreciso de\b|\bpode(ria)? (me|mandar|enviar)\b/i;

/** Conteudo improprio: regex nao resolve o problema, mas evita o pior. */
const IMPROPRIO = /\bfinal feliz\b|\bsex[ou]|\bsexual|\bsafad|\btesao\b|\bsacanag|\bputaria\b|\bpelad/i;

/** Palavras que invertem o sentido do elogio quando vem antes dele. */
const NEGADORES = new Set(['nao', 'nunca', 'nada', 'nem', 'jamais', 'sem', 'pouco']);

/** Sinais claros de que o paciente esta bem. */
const POSITIVO = new RegExp(
  [
    '\\bbem\\b', '\\bbom\\b', '\\bboa\\b', 'otim', 'melhor', 'maravilh',
    'excelente', 'perfeit', 'tudo certo', 'certinh', 'tudo ok', 'tudo tranquilo',
    'aliviad', 'alivio', 'joia', '\\bshow\\b', '\\btop\\b', 'recuperad',
    '100%', 'sensacional', 'incrivel', 'adorei', 'gostei', 'satisfeit',
    '\\bleve\\b', '\\bsolto\\b', 'disposi', 'renovad', 'agradecid',
  ].join('|'),
  'i',
);

/**
 * O elogio esta negado? Procura um negador nas 3 palavras anteriores a cada
 * ocorrencia positiva. "Nao me sinto bem" e "Nao gostei do atendimento" caem aqui.
 */
function elogioNegado(texto) {
  const palavras = texto.split(/\s+/).filter(Boolean);
  for (let i = 0; i < palavras.length; i++) {
    if (!POSITIVO.test(palavras[i])) continue;
    for (let j = Math.max(0, i - 3); j < i; j++) {
      if (NEGADORES.has(palavras[j].replace(/[^a-z0-9]/g, ''))) return true;
    }
  }
  return false;
}

/**
 * @param {string} texto - todas as respostas do paciente na janela, concatenadas
 * @returns {{elegivel: boolean, motivo: string}}
 */
export function respostaClaramentePositiva(texto) {
  const bruto = String(texto || '').trim();
  if (!bruto) return { elegivel: false, motivo: 'vazio' };

  const norm = normalizar(bruto);

  if (bruto.includes('?')) return { elegivel: false, motivo: 'pergunta' };
  if (IMPROPRIO.test(norm)) return { elegivel: false, motivo: 'improprio' };
  if (PEDIDO.test(norm)) return { elegivel: false, motivo: 'pedido' };
  if (AGENDA.test(norm)) return { elegivel: false, motivo: 'agenda' };

  // Dor negada e elogio, nao queixa: tirar antes de procurar sintoma.
  const semDorNegada = norm.replace(DOR_NEGADA, ' ');
  if (QUEIXA.test(semDorNegada)) return { elegivel: false, motivo: 'queixa' };
  if (MEIO_TERMO.test(norm)) return { elegivel: false, motivo: 'meio-termo' };
  if (RESSALVA.test(norm) && !/\bainda bem\b/i.test(norm)) {
    return { elegivel: false, motivo: 'ressalva' };
  }

  // Parte do texto SEM a dor negada: senao o "sem" de "sem dor nenhuma" seria
  // lido como negacao do elogio que vem depois ("Estou sem dor nenhuma, otimo").
  let restante = semDorNegada.replace(SAUDACOES, ' ').replace(/\s+/g, ' ').trim();
  // O "tudo bem" inicial so e cumprimento quando a mensagem CONTINUA depois dele.
  // Se a resposta inteira e "tudo certo, obrigado", ela e o proprio sinal positivo.
  const semCumprimento = restante.replace(CUMPRIMENTO_TUDO_BEM, ' ').trim();
  if (semCumprimento.split(/\s+/).filter(Boolean).length >= 4) restante = semCumprimento;
  if (!restante) return { elegivel: false, motivo: 'so-saudacao' };

  if (elogioNegado(restante)) return { elegivel: false, motivo: 'negacao' };
  if (!POSITIVO.test(restante)) return { elegivel: false, motivo: 'sem-sinal-positivo' };

  return { elegivel: true, motivo: 'positivo' };
}
