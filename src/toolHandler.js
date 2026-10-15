// ─── Handler de Execução de Tools ──────────────────────────────────────────────
// Recebe tool_name + tool_input do Claude response e executa via crmApi

import {
  listProfessionals,
  checkAvailability,
  findOrCreatePatient,
  createAppointment,
  cancelAppointment,
  rescheduleAppointment,
  getPatientAppointments,
  getPatientAppointmentsById,
  getPatientPackages,
  addToWaitlist,
  getFollowUpsByPhone,
  updateFollowUp,
  createFollowUp,
} from './crmApi.js';

// ─── Rastreamento de última check_availability por paciente (phone) ─────────
// Usado para detectar divergência de data entre check_availability e create_appointment.
const lastAvailabilityCheck = new Map(); // phone -> { professionalId, date, ts }
const AVAILABILITY_TTL_MS = 5 * 60 * 1000; // 5 min

// ─── Rastreamento de create_appointment bem-sucedidos por paciente (phone) ──
// Usado para avisar o LLM quando ele chama check_availability na mesma data
// logo após criar um agendamento — evita interpretar o próprio slot como "ocupado
// por outro paciente". Casos Lidia/Carol (12/mai) e Dimitri/Anna (12/mai).
const recentCreates = new Map(); // phone -> [{ professionalId, date, time, ts }, ...]
// 24h, nao 10 min: caso Joaquim/Luana (02/set/2026) — 23 min depois de
// confirmar, um "Top" do paciente fez o LLM re-verificar a agenda, ver o
// horario ocupado pela propria marcacao e pedir desculpas oferecendo outro.
// O aviso e inofensivo; a conversa pode durar horas.
const RECENT_CREATE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// ─── Telefone do cadastro no CRM de cada paciente visto em find_or_create_patient ──
// O create_appointment usa para saber se a consulta é do dono da conversa ou de
// outra pessoa antes de mexer nos retornos pós-alta dele (02/10/2026).
const fonePorPacienteCrm = new Map(); // patientId (CRM) -> telefone do cadastro

// ─── Trava de TROCA x SESSÃO A MAIS (30/09/2026) ─────────────────────────────
// Gabriela (29/09) queria TROCAR e ficou com duas; Felipe Sica (29/09) queria
// uma A MAIS e teve a dele movida. Frases quase iguais tinham intenções opostas,
// então o código só BARRA quando não vê evidência e manda PERGUNTAR; quem
// interpreta a resposta ("trocar", "não é troca, quero as duas") é o LLM.
// Consulta que a Claudia criou/remarcou para este telefone há menos disso é
// ajuste da própria marcação (Dimitri 12/05, Felipe Sica 19/08).
const ISENCAO_CRIADA_HA_POUCO_MS = 10 * 60 * 1000; // 10 min
// Card reagendar_pendente/cancelou aberto há até 30 dias (expiração do Kanban):
// a próxima consulta é a REPOSIÇÃO da liberada.
const CARD_REPOSICAO_TTL_MS = 30 * 24 * 3600000;

// Evidência nas falas do PACIENTE (turnCtx.userText = últimas 3h: a Sabrine
// escolheu o horário 2h15 depois do "eu tb quero"). Medido no histórico: A MAIS
// casa nos lotes (Osmira, Rafael "seções", Sabrine "tb") e em 0 das 6 trocas;
// "a próxima sessão" (singular) não entra, "retorno" só com marcar/agendar.
const RE_A_MAIS = /mais uma|outra sess|tamb[eé]m|\btb\b|al[eé]m d[aoe]|as duas|ambas|ambos|\bos dois\b|\bas 2\b(?!\s*(h|hs|horas?|da|:))|novo pacote|pacote|deixar tudo agendado|as outras|as pr[oó]ximas sess|(marcar|agendar|deixa[r]?)[^.?!]{0,15}retorno|sess[oõ]es|se[cç][oõ]es|adicional|pode manter|mant[eé]m (as|os|a de|o de)|manter as duas/i;
// TROCA: "não vou poder" solto não conta ("não vou conseguir esperar, tô com
// muita dor" fala da DOR); só com "ir/comparecer" ou com o dia antes.
const RE_TROCA = /remarc|reagend|troc|mud[ae]|mudar|pass(a|ar)? (pra|para)|\badi[ae]|em vez|ao inv[eé]s|no lugar|n[aã]o (vou|posso|consigo|poderei|poderia|conseguirei|conseguiria)( mais)?( (poder|conseguir))? (ir|comparecer)|(segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|amanh[ãa]|hoje|dia \d{1,2})[^.?!\n]{0,25}n[aã]o (vou|posso|consigo)( (conseguir|poder))?\b|imprevisto|cancel|desmar[cq]|errad/i;
// "antecipar" só com destino e sem dor ("antecipar para quarta", Alfredo 17/08).
const RE_ANTECIPA = /antecip[^.?!\n]{0,40}\b(pra|para|p\/)\s/i;
const RE_DOR = /\bdor(es)?\b|doendo|\bd[oó]i\b/i;
// "A mais" com todas as letras desmente a troca ("mais uma sessão, tem outro dia?").
const RE_A_MAIS_FORTE = /mais uma (sess|consulta)|outra sess|tamb[eé]m quero|quero tamb[eé]m|\btb\b quero|al[eé]m d[ao] (?!mais)|(ficar|fico|quero|manter|mant[eé]m|com) (com )?(as duas|ambas|os dois)|\b(2|duas) consultas|(sess[aã]o|consulta) (a mais|extra|adicional)/i;
const sinalDeTroca = (txt) => (RE_TROCA.test(txt) || (RE_ANTECIPA.test(txt) && !RE_DOR.test(txt))) && !RE_A_MAIS_FORTE.test(txt);
const SINAL = 'pedido de troca nas falas';

// Resposta VAGA à pergunta de troca: a mensagem INTEIRA (sem acento/pontuação/
// emoji) cabe neste vocabulário de afirmação/agradecimento/"não sei", mais o
// horário repetido ("Simmm", "Tá bom", "Sim, às 13h", "Não sei"). Não decide
// nada: o bloqueio se repete com a pergunta simples. Qualquer palavra fora dele
// ("as duas", "trocar", "sexta mesmo") é do paciente para o LLM ler; o código não
// tenta entender. Histórico: 356 respostas só de afirmação; a lista fechada da
// v4 deixava 57 de fora ("quero sim", "pode marcar", "ok obrigada").
const VAGA_PAL = new Set(('sim s ss ok okay pode ser tudo bem beleza blz certo isso mesmo perfeito fechado fechou ' +
  'show top joia legal confirmo confirmar combinado ta bom claro com certeza quero marcar marca por favor pfv ' +
  'obrigado obrigada obg brigado brigada valeu vlw aham uhum otimo vamos bora nao sei tanto faz e as a o').split(' '));
const ehPalVaga = (w) => VAGA_PAL.has(w) || /^s+i+m+$|^o+k+$|^\d{1,2}(h\d{0,2}|hs|\d{2})?$/.test(w);
const ehRespostaVaga = (msg) => String(msg || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).every(ehPalVaga);
const respostaVaga = (tc) => !!tc?.perguntaPendente && ehRespostaVaga(tc.msgAtual);
// Para LIBERAR, a pergunta tem de ter chegado ao paciente (perguntaFeita = a
// última fala da Claudia é a pergunta). A marca gravada pelo BLOQUEIO só desliga
// atalhos: se o LLM reofereceu horários em vez de perguntar, "11h" não é resposta.
const respostaClara = (tc) => !!tc?.perguntaPendente && (tc.perguntaFeita ?? true) && !ehRespostaVaga(tc.msgAtual);

// additionalSession só vale com evidência que o código vê: resposta não vaga à
// pergunta, "a mais" nas falas, ou algo cancelado no turno COM pedido de
// troca/cancelamento (sem isso, cancel+create era o contorno do caso Felipe).
const evidenciaDeAMais = (tc) => !tc || respostaClara(tc) || RE_A_MAIS.test(tc.userText || '') ||
  (tc.cancelledAppointmentIds?.size > 0 && RE_TROCA.test(tc.userText || ''));

// Mover (ou cancelar para mover) ESTA consulta está livre? Motivo (log) ou null.
function motivoLivre(tc, phone, apt) {
  const agora = Date.now();
  const recente = (recentCreates.get(phone) || []).some((c) => !c.remarcada && agora - c.ts < ISENCAO_CRIADA_HA_POUCO_MS &&
    (c.id === apt.id || (c.date === apt.date && c.time === apt.time)));
  if (recente && !RE_A_MAIS.test(tc.userText || '')) return 'criada/remarcada pela Claudia há menos de 10 min';
  if (instanteBRT(apt.date, apt.time) <= agora) return 'a consulta já passou';
  if (respostaClara(tc)) return `resposta à pergunta: "${String(tc.msgAtual).slice(0, 40)}"`;
  return sinalDeTroca(tc.userText || '') ? SINAL : null;
}

// Mensagens de bloqueio: descrevem a situação e dão as regras; o LLM escolhe
// pelo que o paciente DISSE. Caminho que a trava barraria de novo (sem
// evidência) vira "confirme com a pergunta" — evita pingue-pongue no turno.
const PERGUNTA_SIMPLES = 'É pra *trocar* ou *ficar com as duas*?';
const PERGUNTA_SIMPLES_VARIAS = 'É pra *trocar* uma delas ou marcar *mais uma*?';
const perguntaTroca = (velha, nova) => `Só pra eu não bagunçar sua agenda 😊 Você quer *trocar* a consulta de ${velha} pela de ${nova}, ou *ficar com as duas*?`;
const listar = (apts) => apts.map((a) => `${descreverConsulta(a.date, a.time)} (id ${a.id})`).join('; ');
function regras(tc, trocar, aMais, pergunta, simples = PERGUNTA_SIMPLES) {
  const confirme = 'o código não achou isso nas falas dele; confirme com a pergunta abaixo';
  return (respostaVaga(tc) ? `\nO paciente respondeu "${String(tc.msgAtual).slice(0, 60)}", que não diz se é trocar ou ficar com as duas.` : '') +
    `\nSiga o que o PACIENTE disse, sem deduzir:\n- Disse claramente que é TROCA → ${trocar || confirme}.\n` +
    `- Disse que quer AS DUAS / mais uma → ${aMais || confirme}.\n` +
    `- Não está claro, ou respondeu só "sim"/"ok" → não chame mais ferramentas agora; pergunte: "${respostaVaga(tc) ? simples : pergunta}"`;
}

// RESCHEDULE_NEEDS_CONFIRMATION: mover (nova = { date, time }) ou cancelar para
// mover (nova = null) sem evidência.
function bloqueioMover(tc, phone, apt, lista, nova) {
  const velha = descreverConsultaRel(apt.date, apt.time);
  console.warn(`⚠️ RESCHEDULE_NEEDS_CONFIRMATION bloqueado — ${phone}: ${nova ? 'mover' : 'cancelar'} ${apt.id} ${apt.date} ${apt.time}${nova ? ` → ${nova.date} ${nova.time}` : ' (lote com create / bloqueio no turno / resposta vaga / após oferta de horário)'}: ${respostaVaga(tc) ? `resposta vaga "${String(tc.msgAtual).slice(0, 30)}"` : 'sem sinal de troca'}`);
  return JSON.stringify({
    error: 'RESCHEDULE_NEEDS_CONFIRMATION',
    message: `NÃO ${nova ? 'MOVI' : 'CANCELEI'}. ${nova ? `Mover a consulta de ${descreverConsulta(apt.date, apt.time)} (id ${apt.id}) para ${descreverConsulta(nova.date, nova.time)}` : `Cancelar a consulta de ${descreverConsulta(apt.date, apt.time)} (id ${apt.id}) agora`} tira ela da agenda, e o paciente não pediu troca nas falas das últimas 3h. Consultas futuras ativas: ${listar(lista)}.` +
      regras(tc, null, evidenciaDeAMais(tc) ? `create_appointment${nova ? ` para ${nova.date} ${nova.time}` : ''} com additionalSession=true, sem mexer nesta` : null,
        nova ? perguntaTroca(velha, descreverConsultaRel(nova.date, nova.time)) : `Só pra eu não bagunçar sua agenda 😊 Você quer *trocar* a consulta de ${velha} por outro dia, ou *ficar com ela* e marcar *mais uma*?`),
    existingAppointment: resumo(apt),
  });
}

// Cancelar para contornar a trava (revisão v3): no mesmo lote de um create,
// depois de um bloqueio no turno, com resposta vaga à pergunta ou logo depois de
// a Claudia OFERECER horário (ofertaHorario), cancelar é mover — vale a regra do
// reschedule. O LLM sempre fez cancel e create em iterações SEPARADAS (8 de 8 no
// log): só o lote não pegava o Felipe ("sexta?" → 11h/14h → "11:00"). Caso Felipe Sica: a regra CORRIGIR ("quero
// na sexta") levava a [cancel 09/10, create 02/10]. Histórico: 9 cancel+create
// em 6,5 meses. Com a oferta: de 89 cancelamentos, até 6 sem pedido de troca
// vieram logo após uma oferta e ganhariam a pergunta (~0,9/mês, cota superior).
function barrarContorno(tc, phone, apt, lista) {
  if (!tc || !apt || !(tc.loteTemCreate || tc.bloqueou || respostaVaga(tc) || tc.ofertaHorario)) return null;
  const motivo = motivoLivre(tc, phone, apt);
  if (!motivo) return bloqueioMover(tc, phone, apt, lista.filter(ativa), null);
  console.log(`🔓 Cancelar ${apt.id} com create/bloqueio no turno: livre (${motivo})`);
  return null;
}

/**
 * Executa uma tool e retorna o resultado formatado para tool_result.
 * turnCtx (opcional; um por turno, criado no laço de tools do agent.js):
 *   createdAppointmentIds / cancelledAppointmentIds: ids mexidos NESTE turno;
 *   additionalSessionPatients: patientId com additionalSession aceito no turno;
 *   perguntaPendente: "trocar ou ficar com as duas?" em aberto ANTES do turno;
 *   msgAtual: a mensagem deste turno; userText: falas do paciente nas últimas 3h;
 *   loteTemCreate / bloqueou: o lote atual tem create / uma trava já barrou no turno.
 *   perguntaFeita: a última fala da Claudia é a pergunta; ofertaHorario: foi oferta de horário.
 */
// Horários que o PRÓPRIO paciente liberou ao pedir reagendamento (botão Reagendar ou
// request_reschedule), guardados por 24 h. Se ele desistir e quiser MANTER, pode voltar a
// ESSE horário mesmo com menos de 12 h de antecedência — mesmo telefone, mesma data e hora,
// mesmo paciente e profissional (quando conhecidos). Caso Thiago (15/10/2026): o botão
// cancelou a de hoje 15h, ele pediu para manter, o create era barrado pelas 12 h e a
// Claudia respondeu "continua confirmada" sem consulta nenhuma. Memória do processo: um
// restart esquece (vale a regra normal das 12 h). Marcar qualquer consulta zera a lista.
const VAGA_LIBERADA_TTL_MS = 24 * 3600 * 1000;
const vagasLiberadas = new Map(); // dígitos do telefone da conversa -> [{ date, time, ts, patientId, professionalId }]
const chaveConversa = (p) => String(p || '').replace(/\D/g, '');
const vigentes = (phone) => (vagasLiberadas.get(chaveConversa(phone)) || []).filter((v) => Date.now() - v.ts < VAGA_LIBERADA_TTL_MS);
export function registrarVagaLiberada(phone, date, time, apt = {}) {
  const k = chaveConversa(phone);
  if (!k || !date || !time) return;
  const lista = vigentes(phone);
  lista.push({ date: String(date).slice(0, 10), time: String(time).slice(0, 5), ts: Date.now(),
    patientId: apt?.patientId || null, professionalId: apt?.professionalId || null });
  vagasLiberadas.set(k, lista);
}
// Com data e hora: aquele horário foi liberado por esta conversa nas últimas 24 h (e, se
// informados dos dois lados, pelo mesmo paciente e com o mesmo profissional)?
// Sem data e hora: o último horário liberado (ou null).
export function vagaLiberadaRecente(phone, date, time, alvo = {}) {
  const lista = vigentes(phone);
  if (!(date && time)) return lista[lista.length - 1] || null;
  return lista.find((v) => v.date === String(date).slice(0, 10) && v.time === String(time).slice(0, 5) &&
    !(v.patientId && alvo?.patientId && v.patientId !== alvo.patientId) &&
    !(v.professionalId && alvo?.professionalId && v.professionalId !== alvo.professionalId)) || null;
}
export function limparVagasLiberadas(phone) { vagasLiberadas.delete(chaveConversa(phone)); }
const vagasLiberadasDoDia = (phone, date, professionalId) => vigentes(phone)
  .filter((v) => v.date === String(date).slice(0, 10) && !(v.professionalId && professionalId && v.professionalId !== professionalId))
  .map((v) => v.time);

// ─── Consultas DESTE telefone que ocupam horário numa data (caso Beatriz, 15/10/2026) ───
// O aviso do recentCreates ("esse horário ocupado foi VOCÊ que criou") vive na memória do
// processo e um restart apaga. A Beatriz marcou o filho para 20/10 15h às 10h32; os deploys
// de 10h37/10h57 reiniciaram a Claudia e, às 13h36, ao responder o preço, ela conferiu a
// agenda, não viu o 15h livre e pediu desculpas oferecendo outro horário. Aqui a fonte é o
// CRM: o paciente do telefone (só com DDD + 8 iguais — Idma (71) × Francisco Cirilo (79)
// dividem os 8 finais) e as consultas futuras DELE naquela data que não aparecem livres.
// Limite: o CRM devolve UM paciente por telefone; em telefone de família com vários
// cadastros, os outros ficam sem aviso (como antes). CRM fora do ar ou lento → sem aviso.
// Telefone: mesma chave de agent.js (chaveFone = DDD + 8), mas SEM o recurso dos 8 finais do
// mesmoTelefoneBR: cadastro gravado sem DDD casaria com qualquer DDD e o nome de outra pessoa
// iria para o modelo (revisão de 15/10). O aviso é opcional; na dúvida, fica de fora.
function chaveFoneBR(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 11) return d.slice(0, 2) + d.slice(3);
  if (d.length === 10) return d;
  return null;
}
const mesmoTelefoneComDDD = (a, b) => { const ka = chaveFoneBR(a); return !!ka && ka === chaveFoneBR(b); };
const PRAZO_CRM_AVISO_MS = 3000;
const comPrazo = (p, ms) => {
  let t;
  return Promise.race([p, new Promise((r) => { t = setTimeout(() => r(null), ms); })]).finally(() => clearTimeout(t));
};
async function consultasDoTelefoneNaData(phone, date, professionalName, livres) {
  try {
    const { searchPatientByPhone } = await import('./crmApi.js');
    const busca = await comPrazo(searchPatientByPhone(phone), PRAZO_CRM_AVISO_MS);
    const pac = busca?.ok && busca.data?.found ? busca.data.patient : null;
    if (!pac?.id || !mesmoTelefoneComDDD(phone, pac.phone)) return [];
    const r = await comPrazo(getPatientAppointmentsById(pac.id), PRAZO_CRM_AVISO_MS);
    if (!r?.ok || !Array.isArray(r.data)) return [];
    const livresHM = (livres || []).map((h) => String(h).slice(0, 5));
    const agora = Date.now();
    // Só consulta ainda por vir: a de hoje que já passou e não foi fechada no CRM não "continua marcada".
    return r.data
      .filter((a) => a.date === date && a.time && !livresHM.includes(String(a.time).slice(0, 5)) &&
        instanteBRT(a.date, String(a.time).slice(0, 5)) > agora &&
        !(a.professionalName && professionalName && a.professionalName !== professionalName))
      .map((a) => ({ time: String(a.time).slice(0, 5), paciente: a.patientName || pac.name || 'paciente deste telefone',
        status: String(a.status || '').replace(/_/g, ' ') }));
  } catch (e) {
    console.warn('⚠️ Consultas do telefone no check_availability:', e?.message || e);
    return [];
  }
}
function avisoConsultasDoTelefone(lista) {
  const horas = lista.map((c) => c.time).join(', ');
  const desc = lista.map((c) => `${c.time} (${c.paciente}, ${c.status})`).join('; ');
  const nomes = [...new Set(lista.map((c) => c.paciente))].join(' / ');
  return {
    consultasDesteTelefone: lista,
    avisoConsultasDesteTelefone:
      `⚠️ ${horas} NÃO aparece(m) em 'slots' porque JÁ É(SÃO) consulta marcada para ESTE MESMO TELEFONE: ${desc}. ` +
      `Não é conflito com paciente de outro telefone e essa consulta continua marcada: NÃO diga que o horário "está ocupado" ` +
      `ou "não está mais disponível", nem peça desculpas oferecendo outro como se ela tivesse se perdido. ` +
      `Se pedirem uma consulta A MAIS nesse mesmo horário, explique que ele já é da consulta de ${nomes}.`,
  };
}

export async function handleToolCall(toolName, toolInput, phone = null, turnCtx = null) {
  console.log(`🔧 Tool call: ${toolName}`, JSON.stringify(toolInput));

  try {
    switch (toolName) {
      case 'list_professionals': {
        const result = await listProfessionals();
        if (!result.ok) return JSON.stringify({ error: result.error });

        let professionals = result.data;

        if (toolInput.specialty) {
          professionals = professionals.filter(
            (p) => p.specialty === toolInput.specialty
          );
        }

        if (professionals.length === 0) {
          return JSON.stringify({
            message: 'Nenhum profissional encontrado para essa especialidade.',
            professionals: [],
          });
        }

        return JSON.stringify({
          message: `Encontrados ${professionals.length} profissional(is).`,
          professionals: professionals.map((p) => ({
            id: p.id,
            name: p.name,
            specialty: p.specialty,
          })),
        });
      }

      case 'check_availability': {
        const { professionalId, date, duration } = toolInput;
        const result = await checkAvailability(professionalId, date, duration);
        if (!result.ok) return JSON.stringify({ error: result.error });

        const { professionalName, dayOfWeek, slots, holidayName } = result.data;

        // ⚠️ Detectar se essa data já teve create_appointment recente (< 10 min).
        // Se sim, o LLM pode interpretar o slot ocupado como conflito externo
        // quando na verdade foi ele mesmo que criou. Avisar explicitamente.
        const ownCreates = phone
          ? (recentCreates.get(phone) || []).filter(
              c => c.professionalId === professionalId
                && c.date === date
                && (Date.now() - c.ts) < RECENT_CREATE_TTL_MS
            )
          : [];

        // Feriado: clínica fechada, retornar mensagem específica.
        // Backend já zera os slots quando é feriado ativo na tabela holidays.
        if (holidayName) {
          return JSON.stringify({
            message: `${formatDateBR(date)} é feriado (${holidayName}) e a clínica não funciona. Sugira outra data ao paciente.`,
            isHoliday: true,
            holidayName,
            dayOfWeek,
            slots: [],
          });
        }

        // Horários desta data ocupados por consulta DESTE telefone no CRM (caso Beatriz 15/10).
        // Os que o recentCreates já avisa ficam de fora (o aviso dele, abaixo, é mais forte).
        const doTelefone = phone
          ? (await consultasDoTelefoneNaData(phone, date, professionalName, slots))
              .filter((c) => !ownCreates.some((o) => String(o.time).slice(0, 5) === c.time))
          : [];
        const avisoDoTelefone = doTelefone.length ? avisoConsultasDoTelefone(doTelefone) : null;
        if (avisoDoTelefone) console.log(`📎 ${doTelefone.map((c) => c.time).join(', ')} de ${date} = consulta deste telefone no CRM — aviso anexado ao check_availability`);

        // Filtrar slots com mínimo 12h de antecedência
        const nowBRT = new Date(Date.now() - 3 * 3600000); // UTC-3
        const minTime = new Date(nowBRT.getTime() + 12 * 3600000); // +12h
        const filteredSlots = slots.filter(slot => {
          const slotDate = new Date(`${date}T${slot}:00`);
          return slotDate >= minTime;
        });

        // O horário que o PRÓPRIO paciente liberou aparece mesmo com < 12 h, se ainda estiver
        // livre no CRM e não tiver passado (sem isso o modelo nunca chegava ao create).
        const proprios = phone ? vagasLiberadasDoDia(phone, date, professionalId)
          .filter((h) => slots.includes(h) && !filteredSlots.includes(h) && new Date(`${date}T${h}:00`) >= nowBRT) : [];
        if (proprios.length) { filteredSlots.push(...proprios); filteredSlots.sort(); }

        if (filteredSlots.length === 0) {
          return JSON.stringify({
            message: `Não há horários disponíveis para ${professionalName} em ${formatDateBR(date)} (${dayOfWeek}). Agendamentos precisam de no mínimo 12h de antecedência.`,
            dayOfWeek,
            slots: [],
            ...(avisoDoTelefone || {}),
          });
        }

        // Registrar último check para validação cruzada em create_appointment
        if (phone) {
          lastAvailabilityCheck.set(phone, {
            professionalId,
            date,
            ts: Date.now(),
          });
        }

        const response = {
          message: `Horários disponíveis para ${professionalName} em ${formatDateBR(date)} (${dayOfWeek}):`,
          professionalName,
          date,
          dayOfWeek,
          slots: filteredSlots,
        };
        if (proprios.length) {
          response.liberadosPeloPaciente = proprios;
          response.aviso = `Os horários ${proprios.join(', ')} foram liberados por ESTE paciente quando pediu para reagendar; ele pode voltar a eles mesmo com menos de 12 h.`;
        }
        if (avisoDoTelefone) Object.assign(response, avisoDoTelefone);

        // Se houver creates recentes nessa data, anexar aviso explícito.
        if (ownCreates.length > 0) {
          const horarios = ownCreates.map(c => c.time).join(', ');
          response.warning =
            `⚠️ ATENÇÃO: você acabou de criar agendamento(s) nesta data nos horários: ${horarios}. ` +
            `Esses slots NÃO aparecem na lista 'slots' acima (estão ocupados) porque VOCÊ MESMA os criou. ` +
            `NÃO interprete como conflito ou indisponibilidade. NÃO volte atrás dizendo "não está disponível" ` +
            `os horários que você acabou de agendar. Se o paciente confirmou, a marcação é FINAL.`;
          response.ownRecentCreates = ownCreates.map(c => ({ time: c.time, createdAgo: `${Math.round((Date.now() - c.ts)/1000)}s` }));
        }

        return JSON.stringify(response);
      }

      case 'find_or_create_patient': {
        // GUARD: ao CRIAR paciente novo, birthDate é OBRIGATÓRIO.
        // Schema da tool diz "opcional" mas o LLM precisa pedir antes de
        // criar. Caso Lílian, Luise Pierote, Mauricio (04/05/2026) — várias
        // pacientes nasceram no banco sem birth_date porque Claudia pulou
        // o pedido seguindo o schema. Aqui rejeitamos a chamada quando
        // tenta criar paciente novo sem birthDate, forçando a IA a coletar.
        //
        // Se paciente JÁ EXISTE no CRM (encontrado por phone), birthDate
        // é desnecessário — tool retorna existente e pula validação.
        const { searchPatientByPhone } = await import('./crmApi.js');
        const existingResult = await searchPatientByPhone(toolInput.phone);
        const exists = existingResult?.ok && existingResult?.data?.found;

        if (!exists && !toolInput.birthDate) {
          return JSON.stringify({
            error: 'BIRTHDATE_REQUIRED',
            message: 'Paciente não está cadastrado no CRM. Antes de criar o cadastro, peça a data de nascimento ao paciente (formato DD/MM/AAAA). Só chame find_or_create_patient novamente DEPOIS de obter a data.',
          });
        }

        const result = await findOrCreatePatient(toolInput);
        if (!result.ok) return JSON.stringify({ error: result.error });

        const { patient, created, birthDateRecorded, birthDateConflict } = result.data;
        if (patient?.id) fonePorPacienteCrm.set(patient.id, String(patient.phone || toolInput.phone || ''));
        // Deixar claro quando o cadastro ficou COMPLETO: antes a API descartava a
        // data de nascimento de paciente existente e o LLM, achando o cadastro
        // incompleto, ficava tentando "finaliza-lo" (caso Luana, 02/set/2026).
        let message = created
          ? `Paciente ${patient.name} cadastrado com sucesso no CRM.`
          : `Paciente ${patient.name} já existe no CRM. Cadastro completo — não peça mais dados.`;
        if (!created && birthDateRecorded) {
          message = `Paciente ${patient.name} já existia no CRM; data de nascimento gravada agora. Cadastro completo — não peça mais dados.`;
        } else if (!created && birthDateConflict) {
          message = `Paciente ${patient.name} já existe no CRM com nascimento ${birthDateConflict.stored}; a data informada (${birthDateConflict.given}) foi ignorada. Não peça de novo — siga com o agendamento.`;
        }
        return JSON.stringify({
          message,
          patientId: patient.id,
          patientName: patient.name,
          created,
        });
      }

      case 'create_appointment': {
        // ⚠️ Validar consistência com último check_availability (defense-in-depth)
        if (phone) {
          const last = lastAvailabilityCheck.get(phone);
          if (last && (Date.now() - last.ts) < AVAILABILITY_TTL_MS) {
            const sameProf = last.professionalId === toolInput.professionalId;
            const sameDate = last.date === toolInput.date;
            if (sameProf && !sameDate && !vagaLiberadaRecente(phone, toolInput.date, toolInput.time, toolInput)) {
              console.warn(`⚠️ Date mismatch bloqueado — paciente ${phone}: check=${last.date}, create=${toolInput.date}`);
              return JSON.stringify({
                error: 'DATE_MISMATCH',
                message: `Inconsistência detectada: você verificou disponibilidade para ${last.date} mas tentou agendar ${toolInput.date}. Chame check_availability novamente com a data correta antes de agendar.`,
              });
            }
          }
        }

        // Validar mínimo 12h de antecedência — ANTES da trava de consulta
        // existente (30/09/2026): senão a Claudia perguntava "trocar ou a mais?"
        // e, depois da resposta, o create caía aqui de qualquer jeito.
        const aptDate = new Date(`${toolInput.date}T${toolInput.time}:00`);
        const nowBRT2 = new Date(Date.now() - 3 * 3600000);
        const minTime2 = new Date(nowBRT2.getTime() + 12 * 3600000);
        if (aptDate < minTime2) {
          // Exceção: voltar ao horário que o PRÓPRIO paciente acabou de liberar (desistiu de reagendar).
          const voltaAoSeu = phone && aptDate >= nowBRT2 && vagaLiberadaRecente(phone, toolInput.date, toolInput.time, toolInput);
          if (!voltaAoSeu) {
            return JSON.stringify({ error: 'Não é possível agendar com menos de 12 horas de antecedência. Por favor, escolha um horário mais adiante.' });
          }
          console.log(`↩️ ${phone} volta ao horário que ele mesmo liberou (${toolInput.date} ${toolInput.time}) — exceção às 12 h`);
        }

        // ⚠️ GUARD: bloqueia create_appointment se paciente já tem agendamento
        // ativo na MESMA DATA (EXISTING_APPOINTMENT). Caso Caio Santos (08/05):
        // pediu mudar 14h→13h e o LLM criou outra. Bypass: forceCreate=true
        // (paciente confirmou duas no mesmo dia).
        // CONSERTADO em 30/09/2026: nunca disparou desde 09/05 (comparava
        // a.professionalId, que o GET não devolve — o Rafael ganhou 09/09 14h E
        // 15h). Busca pelo patientId (telefone de família: Dimitri/Anna 12/05,
        // Magali/Nair 15/06) e ignora consulta que já passou.
        // ESTENDIDO para OUTRA data (FUTURE_APPOINTMENT_EXISTS), caso Gabriela:
        // em 7 meses 6 trocas viraram duas consultas e 5 eram sessão a mais —
        // o código não decide, PERGUNTA. Não barra: criadas neste turno (lote,
        // Rafael 05/08, Osmira), additionalSession com evidência e o CASO A
        // (card de reposição aberto). FAIL-OPEN se o CRM não responder.
        if (toolInput.patientId && toolInput.date && toolInput.time) {
          try {
            const aptsResult = await getPatientAppointmentsById(toolInput.patientId);
            if (!aptsResult?.ok || !Array.isArray(aptsResult.data)) {
              console.warn(`⚠️ Guard de consulta existente indisponível (fail-open) — paciente ${toolInput.patientId}: ${aptsResult?.error || 'resposta inválida'}`);
            } else {
              // professionalId: o GET não devolve e só há 1 profissional; se a
              // psicologia voltar, incluir a.professional_id no SELECT do CRM.
              const ativas = aptsResult.data.filter((a) => ativa(a) &&
                !(a.professionalId && toolInput.professionalId && a.professionalId !== toolInput.professionalId));
              const pedida = descreverConsulta(toolInput.date, toolInput.time);
              // forceCreate exige a mesma evidência da additionalSession (sem ela,
              // "Sim" à pergunta criava a duplicata do Caio/Rafael).
              const forceAceito = toolInput.forceCreate === true && evidenciaDeAMais(turnCtx);
              const conflict = forceAceito ? null : ativas.find((a) => a.date === toolInput.date);
              if (conflict) {
                if (toolInput.forceCreate === true) console.warn(`🟠 forceCreate sem evidência — ${phone} (paciente ${toolInput.patientId}) pediu ${toolInput.date} ${toolInput.time}: flag ignorada`);
                console.warn(`⚠️ EXISTING_APPOINTMENT bloqueado — paciente ${phone} já tem ${conflict.id} em ${conflict.date} ${conflict.time}${respostaVaga(turnCtx) ? ' (resposta vaga)' : ''}`);
                const tem = descreverConsulta(conflict.date, conflict.time);
                return JSON.stringify({
                  error: 'EXISTING_APPOINTMENT',
                  message: `NÃO CRIEI. O paciente já tem consulta nesse dia: ${tem} (id ${conflict.id}). Pedida agora: ${pedida}.` +
                    (toolInput.forceCreate === true ? ' forceCreate foi ignorado: nas falas dele não há "a mais" nem resposta à pergunta.' : '') +
                    regras(turnCtx, `reschedule_appointment com appointmentId="${conflict.id}", newDate="${toolInput.date}", newTime="${toolInput.time}" (muda só a hora)`,
                      evidenciaDeAMais(turnCtx) ? 'create_appointment de novo com forceCreate=true (raro: sessões seguidas no mesmo dia)' : null,
                      `Você quer *trocar* o horário da consulta de ${tem} para ${pedida.split(' às ')[1]}, ou *ficar com as duas* no mesmo dia?`),
                  existingAppointment: resumo(conflict),
                });
              }
              const outras = ativas.filter((a) => a.date !== toolInput.date && !turnCtx?.createdAppointmentIds?.has(a.id))
                .sort((a, b) => instanteBRT(a.date, a.time) - instanteBRT(b.date, b.time));
              const flagAceita = toolInput.additionalSession === true && evidenciaDeAMais(turnCtx);
              if (outras.length > 0) {
                // forceCreate só conta como "a mais" se há MESMO consulta na mesma
                // data; a flag aceita vale para as seguintes do MESMO paciente.
                const forceNaMesmaData = forceAceito && ativas.some((a) => a.date === toolInput.date);
                const herdado = turnCtx?.additionalSessionPatients?.has(toolInput.patientId);
                const lista = outras.map((a) => `${a.date} ${a.time}`).join(', ');
                if (flagAceita || forceNaMesmaData || herdado) {
                  console.log(`🟡 additionalSession — ${phone} (paciente ${toolInput.patientId}) marca ${toolInput.date} ${toolInput.time} ALÉM de ${lista}${flagAceita ? '' : forceNaMesmaData ? ' (forceCreate na mesma data)' : ' (herdado do mesmo turno)'}`);
                } else {
                  const cards = await buscarCardsReposicao(phone, toolInput.patientId);
                  const ids = new Set(outras.map((a) => a.id));
                  const liberado = cards.lista.find((c) => !c.aptId || !ids.has(c.aptId));
                  if (liberado) {
                    console.log(`🔓 CASO A — card ${liberado.source} ${liberado.card.id} aberto (apt ${liberado.aptId || '?'} já liberado): create de ${toolInput.date} ${toolInput.time} segue apesar de ${outras.length} outra(s) consulta(s)`);
                  } else if (cards.falhou) {
                    console.warn(`⚠️ Guard de consulta existente: leitura dos cards falhou (fail-open) — ${phone} marca ${toolInput.date} ${toolInput.time} com ${outras.length} outra(s) consulta(s)`);
                  } else {
                    const flag = toolInput.additionalSession === true;
                    if (flag) console.warn(`🟠 additionalSession sem evidência — ${phone} (paciente ${toolInput.patientId}) pediu ${toolInput.date} ${toolInput.time} com ${lista}: flag ignorada`);
                    console.warn(`⚠️ FUTURE_APPOINTMENT_EXISTS bloqueado — ${phone} (paciente ${toolInput.patientId}) pediu ${toolInput.date} ${toolInput.time}, já tem ${lista}${respostaVaga(turnCtx) ? ' (resposta vaga)' : ''}`);
                    const uma = outras.length === 1;
                    const nova = descreverConsultaRel(toolInput.date, toolInput.time);
                    const descr = outras.map((a) => descreverConsultaRel(a.date, a.time));
                    return JSON.stringify({
                      error: 'FUTURE_APPOINTMENT_EXISTS',
                      message: `NÃO CRIEI. Consultas futuras ativas do paciente: ${listar(outras)}. Pedida agora: ${pedida}.` +
                        (flag ? ' additionalSession foi ignorado: nas falas dele não há "a mais" nem resposta à pergunta.' : '') +
                        regras(turnCtx,
                          outras.some((a) => !turnCtx || motivoLivre(turnCtx, phone, a)) ? `reschedule_appointment na consulta que ELE indicou (id acima), newDate="${toolInput.date}", newTime="${toolInput.time}"` : null,
                          evidenciaDeAMais(turnCtx) ? 'create_appointment de novo com additionalSession=true' : null,
                          uma ? perguntaTroca(descr[0], nova) : `Só pra eu não bagunçar sua agenda 😊 A consulta de ${nova} seria *no lugar* de uma das suas (${juntarComOu(descr)}) ou *mais uma*?`,
                          uma ? PERGUNTA_SIMPLES : PERGUNTA_SIMPLES_VARIAS),
                      existingAppointments: outras.map(resumo),
                    });
                  }
                }
              }
              if (flagAceita && turnCtx?.additionalSessionPatients) turnCtx.additionalSessionPatients.add(toolInput.patientId);
            }
          } catch (e) {
            // Falha no guard não bloqueia o fluxo principal — só loga
            console.warn('⚠️ Falha no guard EXISTING_APPOINTMENT:', e.message);
          }
        }
        if (toolInput.forceCreate) {
          console.log(`🟡 forceCreate=true — bypass do guard EXISTING_APPOINTMENT pra ${phone}`);
        }

        const result = await createAppointment(toolInput);
        if (!result.ok) {
          return JSON.stringify({
            error: result.error,
            message: `Não foi possível criar o agendamento: ${result.error}`,
          });
        }

        const apt = result.data;
        // Lote no mesmo turno: a próxima criação não é barrada por esta.
        if (apt?.id) turnCtx?.createdAppointmentIds?.add(apt.id);

        // Registrar create bem-sucedido em recentCreates pra evitar confusão se LLM
        // chamar check_availability na mesma data logo depois.
        if (phone) {
          const arr = recentCreates.get(phone) || [];
          arr.push({
            id: apt.id,
            professionalId: toolInput.professionalId,
            date: apt.date,
            time: apt.time,
            ts: Date.now(),
          });
          // Limpar entradas expiradas pra Map não crescer indefinido
          const cutoff = Date.now() - RECENT_CREATE_TTL_MS;
          recentCreates.set(phone, arr.filter(c => c.ts > cutoff));
        }

        // Paciente de ALTA que agendou consulta nova → reativar status local +
        // cancelar retornos pós-alta pendentes na hora (o CRM já reativa do lado
        // dele no POST /appointments; aqui fecha o lado da Claudia sem esperar o
        // cron). Nova alta futura recria o ciclo. (Caso Julia Camelier, 03/jul/2026.)
        // Só quando a consulta é DO DONO da conversa: quem marcava para outra
        // pessoa pelo próprio WhatsApp perdia os retornos e ficava com alta no
        // CRM e nenhum contato previsto (Monique 17/09 e Marília 28/09/2026, 2 de
        // 46). Na dúvida não cancela: o sendFollowup confere de novo antes de enviar.
        if (phone) {
          try {
            const db = (await import('./database.js')).default;
            const lp = db.prepare("SELECT id, status FROM patients WHERE phone = ?").get(phone);
            if (lp && (lp.status === 'alta_confirmada' || lp.status === 'alta')) {
              const doDono = await consultaEhDoDonoDaConversa(toolInput.patientId, phone);
              if (doDono !== true) {
                console.log(`↪️ Paciente #${lp.id} está de alta e a consulta é ${doDono === false ? 'de outra pessoa' : 'de dono não conferido'} (${toolInput.patientId}) — retornos pós-alta dele mantidos`);
              } else {
                db.prepare("UPDATE patients SET status='em_tratamento', discharge_date=NULL WHERE id = ?").run(lp.id);
                const cancelled = db.prepare(
                  "UPDATE followups SET status='cancelado' WHERE patient_id = ? AND status='pendente' AND type LIKE 'lembrete_%' AND type != 'lembrete_consulta'"
                ).run(lp.id).changes;
                console.log(`🔄 Paciente #${lp.id} estava de alta e agendou — reativado (em_tratamento), ${cancelled} retorno(s) pós-alta cancelado(s)`);
              }
            }
          } catch (e) { console.warn('⚠️ Erro ao reativar paciente pós-alta:', e.message); }
        }

        const response = {
          message: `Agendamento criado com sucesso! IMPORTANTE: a marcação é FINAL. NÃO chame check_availability nesta data nos próximos turnos. NÃO volte atrás dizendo "não está disponível".`,
          appointmentId: apt.id,
          date: apt.date,
          time: apt.time,
          duration: apt.duration,
          status: apt.status,
        };

        // Se foi vinculado a um pacote, incluir info
        if (apt.packageInfo) {
          response.packageInfo = apt.packageInfo;
          response.message = `Agendamento criado com sucesso! Sessão vinculada ao pacote "${apt.packageInfo.packageName}" (${apt.packageInfo.usedSessions + apt.packageInfo.scheduledAfter}/${apt.packageInfo.totalSessions} usadas/agendadas, restam ${apt.packageInfo.remainingAfter}). IMPORTANTE: marcação é FINAL.`;
        }

        return JSON.stringify(response);
      }

      case 'cancel_appointment': {
        const { appointmentId, reason } = toolInput;
        const cphone = toolInput.phone || phone;
        // Captura os dados da consulta ANTES de cancelar (pro card do Kanban;
        // depois do cancelamento ela some da lista de pendentes)
        let cancelledApt = null;
        let arr = [];
        try {
          const aptsRes = await getPatientAppointments(cphone);
          arr = Array.isArray(aptsRes?.data) ? aptsRes.data : [];
          cancelledApt = arr.find((a) => a.id === appointmentId) || null;
        } catch { /* sem card, cancelamento segue normal */ }
        let trava = { apt: cancelledApt, lista: arr };
        if (!cancelledApt && turnCtx) trava = await acharConsultaPorTelefone(phone, appointmentId);
        const barra = barrarContorno(turnCtx, phone, trava.apt, trava.lista);
        if (barra) return barra;

        const result = await cancelAppointment(appointmentId, reason);
        if (!result.ok) return JSON.stringify({ error: result.error });
        turnCtx?.cancelledAppointmentIds?.add(appointmentId);

        // Card "cancelou" no Kanban — paciente que desmarca sem reagendar não
        // some do radar (espelha o card do request_reschedule; se ele remarcar,
        // o auto-update do CRM move o card para "agendou"). Dedupe por apt_id.
        try {
          if (cancelledApt) {
            const fuRes = await getFollowUpsByPhone(cphone);
            const fuArr = Array.isArray(fuRes?.data) ? fuRes.data : [];
            const already = fuArr.some((f) =>
              f.source === 'cancelou' && f.status !== 'agendou' && f.status !== 'perdido' &&
              typeof f.notes === 'string' && f.notes.includes(`[apt_id:${appointmentId}]`));
            if (!already) {
              const [y, m, d] = String(cancelledApt.date || '').split('-');
              const dateBR = y && m && d ? `${d}/${m}` : (cancelledApt.date || '?');
              await createFollowUp({
                id: 'canc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
                patientId: null,
                patientName: cancelledApt.patientName || 'Paciente',
                phone: cphone,
                type: 'cancelamento',
                status: 'respondeu',
                source: 'cancelou',
                notes: `Cancelou consulta de ${dateBR} às ${cancelledApt.time || '?'} via WhatsApp (sem reagendar)\n[apt_id:${appointmentId}]`,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              });
              console.log(`🚫 Card "cancelou" criado no Kanban (apt ${appointmentId})`);
            }
          }
        } catch (err) {
          console.warn('⚠️ cancel_appointment: erro ao criar card:', err.message);
        }

        const response = {
          message: 'Agendamento cancelado com sucesso.',
          appointmentId,
        };

        // Se há pacientes na lista de espera, incluir na resposta
        if (result.data.waitlistMatches && result.data.waitlistMatches.length > 0) {
          response.waitlistMatches = result.data.waitlistMatches;
          response.message += ` Há ${result.data.waitlistMatches.length} paciente(s) na lista de espera para esta data/profissional.`;
        }

        return JSON.stringify(response);
      }

      case 'request_reschedule': {
        // Paciente pediu para reagendar mas AINDA NÃO informou o novo horário.
        // Cancela a consulta atual (LIBERA o slot na agenda) + cria card
        // "reagendar_pendente" no Kanban. Quando o paciente informar o novo
        // dia/horário, a Claudia usa create_appointment (consulta nova) e o
        // auto-update do CRM fecha o card. Caso Jessica (16/jun/2026).
        const rphone = toolInput.phone || phone;
        const aptsResult = await getPatientAppointments(rphone);
        const aptsArr = Array.isArray(aptsResult?.data) ? aptsResult.data : [];
        // Só consulta que AINDA NÃO ACONTECEU (30/09/2026): o GET devolve date >=
        // hoje sem olhar a hora, e a sessão de hoje às 9h ainda 'agendado' às 15h
        // seria cancelada (sai da cobrança e do pacote).
        const agoraRR = Date.now();
        // A de HOJE que já começou (ou já passou e segue ativa) fica de fora da
        // lista; sem appointmentId, "me atrasei"/"perdi o horário" cancelaria a
        // PRÓXIMA (Welton 17/08 13h12, com mais uma marcada). Não cancela nada.
        const hojeBRT = new Date(agoraRR - 3 * 3600000).toISOString().slice(0, 10);
        const comecou = aptsArr.find((a) => ['agendado', 'confirmado', 'em_atendimento'].includes(a.status) &&
          a.date === hojeBRT && instanteBRT(a.date, a.time) <= agoraRR);
        const future = aptsArr
          .filter((a) => a.status !== 'cancelado' && instanteBRT(a.date, a.time) > agoraRR)
          .sort((a, b) => new Date(`${a.date}T${a.time || '00:00'}`) - new Date(`${b.date}T${b.time || '00:00'}`));
        // appointmentId OPCIONAL: com 2+ consultas, cancelar future[0] às cegas
        // libera a sessão errada ("trocar a do dia 13" cancelava a de 06/10 da Osmira).
        const aptsLista = future.map((a) => ({ id: a.id, date: formatDateBR(a.date), time: a.time, status: a.status }));
        if (comecou && !toolInput.appointmentId) {
          console.warn(`⚠️ request_reschedule WHICH_APPOINTMENT — ${rphone}: a de hoje ${comecou.id} ${comecou.time} já começou; nenhum appointmentId`);
          return JSON.stringify({
            error: 'WHICH_APPOINTMENT',
            message: `NADA FOI CANCELADO. A consulta de hoje às ${comecou.time} já começou. Se ele fala dela (atraso, perdeu o horário), não cancele: avise que o Dr. Diego vai ver. ` +
              `Se fala de outra, chame request_reschedule de novo com o appointmentId dela${future.length ? ` (futuras: ${listar(future)})` : ''}.`,
            appointments: aptsLista,
          });
        }
        let nextApt = future[0];
        if (toolInput.appointmentId) {
          nextApt = future.find((a) => a.id === toolInput.appointmentId);
          if (!nextApt) {
            console.warn(`⚠️ request_reschedule APPOINTMENT_NOT_FOUND — ${rphone}: ${toolInput.appointmentId} fora das ${future.length} futura(s) ativa(s)`);
            return JSON.stringify({
              error: 'APPOINTMENT_NOT_FOUND',
              message: `A consulta ${toolInput.appointmentId} não está entre as consultas futuras ativas do paciente. Nada foi cancelado. Confira a lista e chame de novo com o id certo.`,
              appointments: aptsLista,
            });
          }
        } else if (future.length > 1) {
          console.warn(`⚠️ request_reschedule WHICH_APPOINTMENT — ${rphone}: ${future.length} consultas futuras e nenhum appointmentId`);
          return JSON.stringify({
            error: 'WHICH_APPOINTMENT',
            message: `NADA FOI CANCELADO. O paciente tem ${future.length} consultas futuras: ${listar(future)}. ` +
              `Se ele já disse qual quer remarcar (pelo dia/data), chame request_reschedule de novo com o appointmentId dela; se não disse, pergunte qual.`,
            appointments: aptsLista,
          });
        }
        if (!nextApt) {
          return JSON.stringify({ message: 'Paciente não tem consulta futura para reagendar. Ofereça agendar uma nova consulta normalmente.' });
        }
        const barra = barrarContorno(turnCtx, phone, nextApt, future);
        if (barra) return barra;

        // 1) Cancela a consulta (libera o horário)
        const cancelRes = await cancelAppointment(nextApt.id, 'Reagendamento solicitado — aguardando novo horário');
        if (!cancelRes.ok) {
          return JSON.stringify({ error: cancelRes.error, message: 'Não consegui liberar o horário atual. Tente novamente.' });
        }
        console.log(`🗓️ request_reschedule: consulta ${nextApt.id} (${nextApt.date} ${nextApt.time}) cancelada — slot liberado`);
        registrarVagaLiberada(phone, nextApt.date, nextApt.time, nextApt);
        turnCtx?.cancelledAppointmentIds?.add(nextApt.id);

        // 2) Cria card reagendar_pendente no Kanban (dedupe por apt_id)
        try {
          const fuResult = await getFollowUpsByPhone(rphone);
          const fuArr = Array.isArray(fuResult?.data) ? fuResult.data : [];
          const already = fuArr.some((f) =>
            f.source === 'reagendar_pendente' && f.status !== 'agendou' && f.status !== 'perdido' &&
            typeof f.notes === 'string' && f.notes.includes(`[apt_id:${nextApt.id}]`));
          if (!already) {
            const [y, m, d] = String(nextApt.date || '').split('-');
            const dateBR = y && m && d ? `${d}/${m}` : (nextApt.date || '?');
            await createFollowUp({
              id: 'reag-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
              patientId: null,
              patientName: nextApt.patientName || 'Paciente',
              phone: rphone,
              type: 'reagendamento',
              status: 'respondeu',
              source: 'reagendar_pendente',
              notes: `Pediu reagendar consulta de ${dateBR} às ${nextApt.time || '?'} (aguardando novo horário)\n[apt_id:${nextApt.id}]`,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
            console.log(`🔄 Card reagendar_pendente criado (apt ${nextApt.id})`);
          }
        } catch (err) {
          console.warn('⚠️ request_reschedule: erro ao criar card:', err.message);
        }

        return JSON.stringify({
          message: `Consulta de ${nextApt.date} às ${nextApt.time} liberada e marcada como reagendamento pendente. Agora pergunte ao paciente qual o novo dia e turno desejados. Quando ele informar, use create_appointment (NÃO reschedule_appointment — a consulta anterior já foi cancelada).`,
        });
      }

      case 'reschedule_appointment': {
        const { appointmentId, newDate, newTime, duration } = toolInput;

        // TRAVA SIMÉTRICA à do create (30/09/2026). Caso Felipe Sica (29/09):
        // tinha sexta 09/10 9h, escreveu "Tem horário sexta? 09:00?" / "Quero pra
        // essa próxima sexta" / "11:00" — queria uma A MAIS e a Claudia MOVEU a de
        // 09/10 (o Diego restaurou). Mudar só a HORA é livre; mudar a DATA exige
        // motivoLivre. Antes do pedido de troca nas falas vem a REPOSICAO_PENDENTE:
        // card aberto de OUTRA consulta já liberada — "Cancelar" → "quero
        // reagendar pra terça" movia a que sobrou; o código só pergunta.
        // Medido (36 reschedules que mudam a data, 17/03–29/09): barra o Felipe
        // 29/09 e 2 ambíguos (Lídia 11/05, Vitória 25/06). FAIL-OPEN se não
        // achar a consulta ou o CRM falhar.
        if (turnCtx && appointmentId && newDate && !turnCtx.createdAppointmentIds?.has(appointmentId)) {
          try {
            const { apt: atual, lista } = await acharConsultaPorTelefone(phone, appointmentId);
            if (!atual) {
              console.warn(`⚠️ Trava do reschedule: consulta ${appointmentId} não achada pelo telefone ${phone} (fail-open)`);
            } else if (atual.date !== newDate) {
              const motivo = motivoLivre(turnCtx, phone, atual);
              // Ajuste S1 (revisão v3): a mensagem pede para trocar ESTA pelo dia/data.
              const [, mo, dd] = atual.date.split('-').map(Number);
              const citaEsta = sinalDeTroca(turnCtx.msgAtual || '') && new RegExp(`\\b0?${dd}/0?${mo}\\b|\\bdia 0?${dd}\\b`).test(turnCtx.msgAtual || '');
              const ativos = new Set(lista.filter(ativa).map((a) => a.id));
              const card = (!motivo || motivo === SINAL) && !citaEsta &&
                (await buscarCardsReposicao(phone)).lista.find((c) => c.aptId && c.aptId !== appointmentId && !ativos.has(c.aptId));
              if (card) {
                console.warn(`⚠️ REPOSICAO_PENDENTE bloqueado — ${phone}: mover ${appointmentId} ${atual.date} → ${newDate} ${newTime}, mas o card ${card.source} ${card.card.id} (apt ${card.aptId}, ${card.nota || '?'}) está aberto`);
                const liberada = card.nota || 'que ele liberou';
                const nova = descreverConsultaRel(newDate, newTime);
                return JSON.stringify({
                  error: 'REPOSICAO_PENDENTE',
                  message: `NÃO MOVI. A consulta de ${liberada} já foi liberada (${card.source === 'cancelou' ? 'Cancelar' : 'Reagendar'}) e ainda não foi reposta; a de ${descreverConsulta(atual.date, atual.time)} (id ${appointmentId}) continua ativa. ` +
                    `Não dá para saber se ${nova} é a reposição da liberada ou a troca desta. Não chame mais ferramentas agora; pergunte: ` +
                    `"A de ${liberada} já foi liberada 😊 O horário de ${nova} é para *repor* aquela, ou para *trocar* esta de ${descreverConsultaRel(atual.date, atual.time)}?"\n` +
                    `- Repor: create_appointment para ${newDate} ${newTime} (a liberada não conta como consulta ativa).\n- Trocar esta: reschedule_appointment de novo com os mesmos dados.`,
                  existingAppointment: resumo(atual),
                });
              }
              if (!motivo) return bloqueioMover(turnCtx, phone, atual, lista.filter(ativa), { date: newDate, time: newTime });
              console.log(`🔓 Trava do reschedule: ${appointmentId} ${atual.date} → ${newDate} livre (${motivo})`);
            }
          } catch (e) {
            console.warn('⚠️ Falha na trava do reschedule (fail-open):', e.message);
          }
        }

        const result = await rescheduleAppointment(appointmentId, newDate, newTime, duration);
        if (!result.ok) {
          return JSON.stringify({
            error: result.error,
            message: `Não foi possível reagendar: ${result.error}`,
          });
        }

        const apt = result.data;

        // Igual ao create (30/09/2026): sem isso o aviso "você acabou de criar
        // agendamento nesta data" do check_availability não aparece para o
        // horário remarcado (erro Joaquim/Luana, 02/09).
        if (phone) {
          const arr = recentCreates.get(phone) || [];
          arr.push({ id: apt.id || appointmentId, remarcada: true, professionalId: apt.professionalId, date: apt.date || newDate, time: apt.time || newTime, ts: Date.now() });
          const cutoff = Date.now() - RECENT_CREATE_TTL_MS;
          recentCreates.set(phone, arr.filter(c => c.ts > cutoff));
        }

        // Fechar follow-up "reagendar_pendente"/"cancelou" desta consulta → 'agendou'.
        // Procurava só por apt.patientPhone || apt.phone, que o PUT /reschedule
        // NUNCA devolve: o card ficava aberto semanas (Mariana 12/05, Joamar 21/05,
        // Ju 02/06, Thais 09/06). Agora também pelo telefone da conversa (30/09/2026).
        try {
          for (const f of await fonesDoPaciente(apt.patientPhone || apt.phone || phone, phone)) {
            const fuResult = await getFollowUpsByPhone(f);
            const fuArr = Array.isArray(fuResult?.data) ? fuResult.data : [];
            const pending = fuArr.find(fu =>
              (fu.source === 'reagendar_pendente' || fu.source === 'cancelou') &&
              fu.status !== 'agendou' &&
              fu.status !== 'perdido' &&
              typeof fu.notes === 'string' &&
              fu.notes.includes(`[apt_id:${appointmentId}]`)
            );
            if (pending) {
              const [y, m, d] = String(apt.date || '').split('-');
              const dateBR = y && m && d ? `${d}/${m}` : (apt.date || '?');
              const newNotes = `${pending.notes || ''} | Reagendado para ${dateBR} ${apt.time || ''}`.trim();
              await updateFollowUp(pending.id, { status: 'agendou', notes: newNotes });
              console.log(`✅ Follow-up ${pending.source} ${pending.id} → 'agendou' (apt ${appointmentId})`);
              break;
            }
          }
        } catch (err) {
          console.warn('⚠️ Erro ao fechar follow-up reagendar_pendente:', err.message);
        }

        return JSON.stringify({
          message: `Agendamento reagendado com sucesso!`,
          appointmentId: apt.id,
          newDate: apt.date,
          newTime: apt.time,
          duration: apt.duration,
          status: apt.status,
        });
      }

      case 'get_patient_appointments': {
        const { phone } = toolInput;
        const result = await getPatientAppointments(phone);
        if (!result.ok) return JSON.stringify({ error: result.error });

        const appointments = result.data;
        if (appointments.length === 0) {
          return JSON.stringify({
            message: 'Nenhum agendamento futuro encontrado para este paciente.',
            appointments: [],
          });
        }

        return JSON.stringify({
          message: `Encontrados ${appointments.length} agendamento(s) futuro(s).`,
          appointments: appointments.map((a) => ({
            id: a.id,
            date: formatDateBR(a.date),
            time: a.time,
            duration: a.duration,
            professionalName: a.professionalName,
            status: a.status,
          })),
        });
      }

      case 'get_patient_packages': {
        const { phone } = toolInput;
        const result = await getPatientPackages(phone);
        if (!result.ok) return JSON.stringify({ error: result.error });

        const packages = result.data;
        if (packages.length === 0) {
          return JSON.stringify({
            message: 'Paciente não possui pacotes de tratamento ativos. Será agendada uma consulta avulsa.',
            packages: [],
          });
        }

        return JSON.stringify({
          message: `Paciente possui ${packages.length} pacote(s) ativo(s).`,
          packages: packages.map((p) => ({
            id: p.id,
            name: p.productName,
            totalSessions: p.totalSessions,
            usedSessions: p.usedSessions,
            scheduledSessions: p.scheduledSessions,
            freeSessions: p.freeSessions,
            amountPaid: p.amountPaid,
            amountTotal: p.amountTotal,
          })),
        });
      }

      case 'add_to_waitlist': {
        const { patientId, professionalId, preferredDate, preferredPeriod } = toolInput;
        const result = await addToWaitlist(patientId, professionalId, preferredDate, preferredPeriod || 'qualquer');
        if (!result.ok) {
          return JSON.stringify({
            error: result.error,
            message: `Não foi possível adicionar à lista de espera: ${result.error}`,
          });
        }

        return JSON.stringify({
          message: `Paciente adicionado à lista de espera para ${formatDateBR(preferredDate)}. Será notificado automaticamente quando abrir uma vaga!`,
          waitlistId: result.data.id,
          preferredDate,
          preferredPeriod: preferredPeriod || 'qualquer',
        });
      }

      default:
        return JSON.stringify({ error: `Tool desconhecida: ${toolName}` });
    }
  } catch (err) {
    console.error(`❌ Erro ao executar tool ${toolName}:`, err.message);
    return JSON.stringify({
      error: `Erro interno ao executar ${toolName}: ${err.message}`,
    });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDateBR(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

// Instante (epoch ms) de uma consulta gravada no horário de Salvador (UTC-3,
// sem horário de verão); não depende do TZ do processo (a VPS roda em UTC).
// Data inválida vira NaN → "NaN > agora" é falso → a consulta é ignorada.
function instanteBRT(date, time) {
  const [y, m, d] = String(date || '').split('-').map(Number);
  const [hh, mi] = String(time || '00:00').split(':').map(Number);
  return Date.UTC(y, m - 1, d, (hh || 0) + 3, mi || 0);
}
// Ativa e ainda por vir (a sessão de hoje não concluída não conta).
const ativa = (a) => (a.status === 'agendado' || a.status === 'confirmado') && instanteBRT(a.date, a.time) > Date.now();
const resumo = (a) => ({ id: a.id, date: a.date, time: a.time, status: a.status });

// "quarta 30/09 às 18h" / "às 14h30" — dia da semana calculado da própria data.
const DIAS_CURTOS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
function descreverConsulta(date, time) {
  const [y, m, d] = String(date || '').split('-').map(Number);
  const [hh, mi] = String(time || '').split(':');
  const dia = y && m && d ? `${DIAS_CURTOS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}` : String(date || '');
  return hh ? `${dia} às ${Number(hh)}h${mi && mi !== '00' ? mi : ''}` : dia;
}
// Idem com "hoje"/"amanhã" pelo dia BRT: "amanhã (quarta, 30/09) às 18h".
function descreverConsultaRel(date, time) {
  const dias = Math.round((Date.parse(date) - Date.parse(new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10))) / 86400000);
  const [dia, hora] = descreverConsulta(date, time).split(' às ');
  if (dias !== 0 && dias !== 1) return descreverConsulta(date, time);
  return `${dias ? 'amanhã' : 'hoje'} (${dia.replace(' ', ', ')})${hora ? ` às ${hora}` : ''}`;
}
// ["a", "b", "c"] → "a, b ou c"
const juntarComOu = (itens) => (itens.length <= 1 ? itens.join('') : `${itens.slice(0, -1).join(', ')} ou ${itens[itens.length - 1]}`);

// Telefones para buscar no CRM: os dados + o contact_phone local de `phone`
// (LID / 9º dígito não casam pelo sufixo-8), sem repetir o sufixo-8.
async function fonesDoPaciente(...dados) {
  const fones = [...dados];
  try {
    const db = (await import('./database.js')).default;
    fones.push(db.prepare('SELECT contact_phone FROM patients WHERE phone = ?').get(dados[dados.length - 1])?.contact_phone);
  } catch { /* sem banco local: só os dados */ }
  const vistos = new Set();
  return fones.filter(Boolean).map(String).filter((f) => {
    const s8 = f.replace(/\D/g, '').slice(-8);
    return s8.length === 8 && !vistos.has(s8) && vistos.add(s8);
  });
}

// A consulta recém-criada é do dono desta conversa? true / false, ou null quando
// não deu para saber. Se o telefone do cadastro agendado (guardado no
// find_or_create_patient do mesmo turno) é um dos telefones da conversa, é dele.
// Senão — ou sem esse telefone, ou se ele mudou no CRM depois — pergunta ao CRM
// de quem são os telefones da conversa.
async function consultaEhDoDonoDaConversa(patientId, phone) {
  const s8 = (f) => String(f).replace(/\D/g, '').slice(-8);
  const fones = await fonesDoPaciente(phone);
  const doAgendado = fonePorPacienteCrm.get(patientId);
  if (doAgendado && s8(doAgendado).length === 8 && fones.some((f) => s8(f) === s8(doAgendado))) return true;

  const { searchPatientByPhone } = await import('./crmApi.js');
  let falhou = false;
  for (const f of fones) {
    const r = await searchPatientByPhone(f);
    if (!r?.ok) { falhou = true; continue; }
    if (r.data?.found && r.data.patient?.id === patientId) return true;
  }
  return falhou || !fones.length ? null : false;
}

// Consulta atual (data/hora ANTES de mover) e a lista do mesmo telefone. O GET
// só filtra por telefone (não há GET por id). Não achou → { apt: null } (fail-open).
async function acharConsultaPorTelefone(phone, appointmentId) {
  for (const f of await fonesDoPaciente(phone)) {
    const r = await getPatientAppointments(f);
    const apt = r?.ok && Array.isArray(r.data) ? r.data.find((a) => a.id === appointmentId) : null;
    if (apt) return { apt, lista: r.data };
  }
  return { apt: null, lista: [] };
}

// Cards de REPOSIÇÃO (CASO A do create, REPOSICAO_PENDENTE do reschedule):
// request_reschedule e o botão "Reagendar" abrem reagendar_pendente;
// cancel_appointment e o botão "Cancelar", cancelou. Os dois trazem
// "[apt_id:X]" e "consulta de DD/MM às HH:MM"; o POST /appointments do CRM
// fecha os abertos no 1º create. Na v1 era só reagendar_pendente e 7 dias:
// depois de um Cancelar ou com card de 8+ dias (10 de 34 reposições desde
// abril) a trava mandava mover a que sobrou. O filtro por patientId quase
// nunca atua (os cards nascem com patientId null).
// Devolve { lista: [{ card, source, aptId, nota }], falhou }.
async function buscarCardsReposicao(phone, patientId = null) {
  const limite = Date.now() - CARD_REPOSICAO_TTL_MS;
  const lista = [];
  let falhou = false;
  for (const f of await fonesDoPaciente(phone)) {
    const r = await getFollowUpsByPhone(f);
    if (!r?.ok || !Array.isArray(r.data)) { falhou = true; continue; }
    for (const c of r.data) {
      if (lista.some((x) => x.card.id === c.id) || !['reagendar_pendente', 'cancelou'].includes(c.source) ||
          !['pendente', 'enviado', 'respondeu'].includes(c.status) || !(new Date(c.createdAt).getTime() > limite) ||
          (c.patientId && patientId && c.patientId !== patientId)) continue;
      const notas = String(c.notes || '');
      lista.push({ card: c, source: c.source, aptId: notas.match(/\[apt_id:([^\]]+)\]/)?.[1] || null, nota: notas.match(/consulta de (\d{2}\/\d{2} às \d{2}:\d{2})/)?.[1] || null });
    }
  }
  // Achou card em um dos telefones: a falha no outro não importa.
  return { lista, falhou: falhou && lista.length === 0 };
}
