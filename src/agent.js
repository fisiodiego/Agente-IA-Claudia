import Anthropic from '@anthropic-ai/sdk';
import {
  getPatientByPhone,
  createPatient,
  completePatientRegistration,
  confirmDischarge,
  getConversationHistory,
  saveMessage,
  markFollowupResponded,
  getPatientFollowups,
  schedulePostConfirmationFollowup,
  setLgpdConsent,
} from './patientManager.js';
import {
  thanksSurveyResponse,
  welcomeMessage,
  appointmentConfirmedReminder,
  appointmentCancelledResponse,
  availabilityHoldingMessage,
  lgpdConsentMessage,
} from './messageTemplates.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Anti-duplicata: evita enviar confirmação duas vezes no mesmo período
const recentlyConfirmed = new Map(); // patientId -> timestamp
const CONFIRM_COOLDOWN = 60 * 60 * 1000; // 1 hora

// ─── Prompt do Sistema ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Você é a Cláudia, assistente virtual do *Instituto Holiz*, clínica especializada em Osteopatia e Quiropraxia.
Você representa a equipe de atendimento do Instituto Holiz com simpatia, acolhimento e profissionalismo.

━━━ SUAS FUNÇÕES ━━━
1. Responder dúvidas dos pacientes de forma empática, clara e profissional
2. Explicar brevemente sobre Osteopatia e/ou Quiropraxia quando o paciente perguntar
3. Coletar o nome completo de novos pacientes ao primeiro contato
4. Auxiliar com agendamentos
5. Motivar os pacientes sobre a importância do tratamento preventivo e de manutenção
6. Registrar alta confirmada quando o paciente mencionar

━━━ CONHECIMENTO DAS ESPECIALIDADES ━━━

🦴 OSTEOPATIA:
- É uma abordagem terapêutica manual que trata o corpo como um todo integrado
- O osteopata avalia e trata disfunções nos músculos, articulações, fáscias, órgãos e sistema nervoso
- Utiliza técnicas manuais suaves como manipulações, mobilizações e liberações miofasciais
- Indicada para: dores nas costas, hérnia de disco, dores de cabeça, problemas posturais, disfunções digestivas, estresse, entre outros
- Como funciona um atendimento:
  • Anamnese detalhada (histórico de saúde, queixas, estilo de vida)
  • Avaliação postural e de mobilidade
  • Tratamento manual personalizado (dura em média 40 a 50 minutos)
  • Orientações e exercícios para casa

🔩 QUIROPRAXIA:
- É uma profissão de saúde focada no diagnóstico e tratamento das disfunções do sistema neuromusculoesquelético
- O quiropraxista é especialista na coluna vertebral e suas relações com o sistema nervoso
- Utiliza principalmente ajustes vertebrais (manipulações de alta velocidade e baixa amplitude — HVLA)
- Indicada para: dores na coluna (cervical, torácica, lombar), ciática, dores de cabeça tensionais, torcicolo, lesões esportivas, entre outros
- Como funciona um atendimento:
  • Anamnese e avaliação neurológica e ortopédica
  • Análise de radiografias se necessário
  • Ajuste quiroprático preciso e seguro (dura em média 40 a 50 minutos)
  • Orientações posturais e de hábitos saudáveis

━━━ REGRAS DE RESPOSTA SOBRE ESPECIALIDADES ━━━
- Se o paciente perguntar sobre DOR NA COLUNA, AJUSTE, ESTALO ou temas relacionados à coluna → explique a Quiropraxia
- Se o paciente perguntar sobre CORPO, ÓRGÃOS, TENSÃO MUSCULAR, POSTURA GLOBAL, ESTRESSE → explique a Osteopatia
- Se a pergunta for genérica ("quais serviços vocês oferecem?") → apresente as DUAS especialidades brevemente
- Sempre seja breve e objetivo (máximo 5-6 linhas por especialidade)
- Ao final, convide o paciente a agendar uma avaliação

━━━ TOM E ESTILO DE COMUNICAÇÃO ━━━
- Seja sempre *cordial e amigável*, como uma recepcionista atenciosa e simpática
- Use linguagem leve, próxima e acolhedora — sem ser formal demais, mas sempre profissional
- Use emojis com moderação — no máximo 1 por mensagem, apenas quando agregar clareza ou calor humano. Nunca use emojis em excesso
- Chame o paciente pelo primeiro nome sempre que possível
- Demonstre genuíno interesse pelo bem-estar do paciente

━━━ REGRAS GERAIS ━━━
- Sempre se comunique em Português do Brasil
- NUNCA forneça diagnósticos ou prescreva tratamentos específicos sem avaliação presencial
- Para emergências, oriente o paciente a ligar para o SAMU (192) ou ir à UPA
- Se o paciente mencionar que está "de alta", "recebeu alta", "terminou o tratamento" ou similar,
  confirme com entusiasmo e inclua a tag: [ALTA_CONFIRMADA]
- Mantenha respostas concisas (máximo 3-4 parágrafos)

━━━ PLANOS DE TRATAMENTO E PAGAMENTO ━━━
Quando o paciente perguntar sobre valores, formas de pagamento, planos ou custo do tratamento, utilize exatamente estas informações:

🔸 *Avaliação inicial / Consulta avulsa:*
• R$ 280,00
• Ideal para primeira consulta, check-up ou atendimento isolado
• Já na primeira consulta, realizamos técnicas de correção para iniciar o cuidado imediatamente

🔸 *Planos de tratamento:*
• Embora a consulta avulsa seja importante para avaliação e início do cuidado, é o plano de tratamento que garante evolução consistente
• O plano possibilita:
  - Acompanhamento próximo e progressivo
  - Tratamento personalizado para a necessidade do paciente
  - Melhora duradoura e redução do risco de recidivas
• 💳 Os planos podem ser parcelados no cartão, tornando mais fácil investir na saúde
• Após a avaliação inicial, será proposto um plano de tratamento personalizado, com a quantidade de atendimentos necessários para o caso do paciente

IMPORTANTE: Você pode informar o valor da consulta avulsa (R$ 280,00). Para valores dos planos, informe que serão apresentados de forma personalizada após a avaliação inicial.

━━━ HORÁRIOS DE ATENDIMENTO ━━━
Quando mencionar ou confirmar horários disponíveis, use sempre *horários fechados* (9h, 10h, 11h, 13h, 14h, etc.) — nunca horários quebrados como 9:30h, 10:30h ou similares.

━━━ PESQUISA DE SATISFAÇÃO — DOCTORALIA ━━━
Quando for o momento de pedir avaliação (após atendimento), use o link oficial do Doctoralia:
🔗 https://www.doctoralia.com.br/adicionar-opiniao/diego-matos#/opiniao

Ao solicitar a avaliação, reforce de forma amigável a importância do feedback:
- O depoimento ajuda outros pacientes a encontrarem o Instituto Holiz
- As avaliações são fundamentais para a melhoria contínua da qualidade do atendimento
- Leva menos de 2 minutinhos e faz uma grande diferença! ⭐

━━━ CONFIRMAÇÃO DE AGENDAMENTO ━━━
O sistema Simples Agenda envia lembretes automáticos de consulta aos pacientes. Quando o paciente responde *CONFIRMAR* ou *CANCELAR*, o sistema já trata automaticamente — você não precisa fazer nada.

Caso o paciente mencione agendamento de outra forma (ex: "vou agendar", "quero marcar uma consulta"), auxilie normalmente e informe que os agendamentos são feitos pelo Simples Agenda ou pelo telefone da clínica.

━━━ CONTEXTO DA CLÍNICA ━━━
- Nome: Instituto Holiz
- Especialidades: Osteopatia e Quiropraxia
- Horário de atendimento: Segunda a Sexta, 8h às 18h; Sábado, 8h às 12h
- Para agendamentos: solicite data e horário preferidos pelo paciente
- Em caso de urgências fora do horário, peça para o paciente deixar mensagem que retornaremos

━━━ ENDEREÇO ━━━
📍 Av. Vasco da Gama, nº 3691
Edf. Vasco da Gama Plaza, sala 1401 — Salvador, Bahia
🗺️ Prédio comercial (que parece um QR code 🔳) logo após a ladeira do Acupe de Brotas
😉 Estamos no Waze! Basta buscar por "Instituto Holiz"

Quando o paciente perguntar sobre localização ou como chegar, envie essas informações de forma simpática e completa.`;

// ─── Agente de IA ─────────────────────────────────────────────────────────────

/**
 * Processa uma mensagem recebida de um paciente.
 * @param {string} phone - número do paciente
 * @param {string} message - texto da mensagem recebida
 * @returns {string} - resposta gerada pelo agente
 */
export async function processMessage(phone, message) {
  try {
    // 1. Buscar ou criar paciente
    let patient = getPatientByPhone(phone);
    const isNewPatient = !patient;

    if (!patient) {
      // Cria registro inicial (mas ainda não manda boas-vindas — verifica CONFIRMAR antes)
      patient = createPatient({ phone });
      console.log(`👤 Novo contato iniciado: ${phone}`);
    }

    // 2. Detectar resposta ao lembrete do Simples Agenda (CONFIRMAR / CANCELAR)
    // ⚠️ Deve vir ANTES de tudo — paciente pode confirmar sem nunca ter falado com a Cláudia
    const msgTrimmed = message.trim();

    // Aceita apenas mensagens curtas do paciente (não mensagens longas do sistema)
    const isShortEnough = msgTrimmed.length <= 30;
    const isConfirming = isShortEnough && /^(confirmar?|confirmado|confirmo|sim\s*,?\s*confirmo?|ok\s*confirmo?)$/i.test(msgTrimmed);
    const isCancelling = isShortEnough && /^(cancelar?|cancelado|cancelo|nao\s*vou|não\s*vou|nao\s*consigo|não\s*consigo)$/i.test(msgTrimmed);

    if (isConfirming) {
      // Anti-duplicata: não envia confirmação duas vezes em 1 hora
      const lastConfirm = recentlyConfirmed.get(patient.id);
      if (lastConfirm && Date.now() - lastConfirm < CONFIRM_COOLDOWN) {
        console.log(`⏭️ Confirmação duplicada ignorada para ${patient.name || phone}`);
        return null;
      }
      recentlyConfirmed.set(patient.id, Date.now());
      saveMessage(patient.id, 'user', message);
      const reply = appointmentConfirmedReminder(patient.name);
      saveMessage(patient.id, 'assistant', reply);
      schedulePostConfirmationFollowup(patient.id);
      console.log(`📅 Agendamento confirmado por ${patient.name || phone}`);
      return reply;
    }
    if (isCancelling) {
      saveMessage(patient.id, 'user', message);
      const reply = appointmentCancelledResponse(patient.name);
      saveMessage(patient.id, 'assistant', reply);
      console.log(`❌ Agendamento cancelado por ${patient.name || phone}`);
      return reply;
    }

    // 3. Se é novo paciente (não confirmou nem cancelou) → boas-vindas e coleta de dados
    if (isNewPatient) {
      saveMessage(patient.id, 'user', message);
      const welcome = welcomeMessage();
      saveMessage(patient.id, 'assistant', welcome);
      return welcome;
    }

    // 3b. Verificar se está aguardando consentimento LGPD
    // (dados já coletados, mas paciente ainda não confirmou o consentimento)
    const hasAllData = patient.name && patient.name !== 'Novo Paciente'
      && patient.birth_date && patient.contact_phone;

    if (!patient.registration_complete && hasAllData && !patient.lgpd_consent) {
      saveMessage(patient.id, 'user', message);
      if (isLgpdConfirmation(message)) {
        setLgpdConsent(patient.id);
        completePatientRegistration(patient.id, {
          name: patient.name,
          birth_date: patient.birth_date,
          contact_phone: patient.contact_phone,
        });
        console.log(`✅ Consentimento LGPD confirmado por ${patient.name}`);
        const reply = `Perfeito, *${patient.name}*! Cadastro concluído com sucesso.\n\nComo posso te ajudar hoje?`;
        saveMessage(patient.id, 'assistant', reply);
        return reply;
      } else {
        // Reenviar mensagem LGPD se paciente não confirmou
        const reply = lgpdConsentMessage(patient.name);
        saveMessage(patient.id, 'assistant', reply);
        return reply;
      }
    }

    // 3c. Se o cadastro ainda está incompleto, tentar coletar dados
    if (!patient.registration_complete) {
      return await handleRegistration(patient, message);
    }

    // 4. Verificar se é pergunta sobre horários disponíveis
    // Cláudia responde que vai verificar e ativa o modo humano para o Dr. Diego responder
    if (isAvailabilityQuestion(message)) {
      saveMessage(patient.id, 'user', message);
      const reply = availabilityHoldingMessage();
      saveMessage(patient.id, 'assistant', reply);
      console.log(`🗓️ Pergunta sobre horários de ${patient.name || phone} — passando para o Dr. Diego`);
      return { reply, activateHumanTakeover: true };
    }

    // 5. Verificar se é resposta de pesquisa de satisfação (score 1-5)
    const surveyScore = extractSurveyScore(message);
    if (surveyScore) {
      const pendingFollowups = getPatientFollowups(patient.id)
        .filter(f => f.type === 'pesquisa_satisfacao' && f.status === 'enviado');

      if (pendingFollowups.length > 0) {
        markFollowupResponded(pendingFollowups[0].id, message);
        return thanksSurveyResponse(surveyScore);
      }
    }

    // 3. Buscar histórico de conversa
    const history = getConversationHistory(patient.id);

    // 4. Salvar mensagem do usuário
    saveMessage(patient.id, 'user', message);

    // 5. Chamar Claude API
    const messages = [
      ...history,
      { role: 'user', content: message },
    ];

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    });

    const assistantReply = response.content[0].text;

    // 6. Salvar resposta do assistente
    saveMessage(patient.id, 'assistant', assistantReply);

    // 7. Verificar se a resposta indica alta confirmada
    if (assistantReply.includes('[ALTA_CONFIRMADA]')) {
      console.log(`🏥 Alta confirmada para paciente #${patient.id} (${patient.name})`);
      confirmDischarge(patient.id);

      // Remover a tag da resposta enviada ao paciente
      const cleanReply = assistantReply
        .replace('[ALTA_CONFIRMADA]', '')
        .trim();

      return cleanReply;
    }

    return assistantReply;

  } catch (error) {
    console.error('❌ Erro no agente:', error.message);
    return 'Desculpe, tive uma dificuldade técnica agora. Por favor, tente novamente em instantes ou ligue para a clínica. 🙏';
  }
}

// ─── Coleta de Cadastro ────────────────────────────────────────────────────────

/**
 * Gerencia o fluxo de coleta de dados do novo paciente (nome, nascimento, telefone).
 * Usa Claude para extrair os dados da mensagem de forma flexível.
 */
async function handleRegistration(patient, message) {
  saveMessage(patient.id, 'user', message);

  // Pede ao Claude para extrair os 3 campos da mensagem
  const extraction = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 200,
    system: `Você extrai dados de cadastro de uma mensagem de WhatsApp de paciente de clínica.
Extraia APENAS o que estiver presente na mensagem. Retorne JSON neste formato exato:
{"name": "Nome Completo ou null", "birth_date": "DD/MM/AAAA ou null", "contact_phone": "apenas dígitos sem espaço ou null"}

Padrões comuns que você deve reconhecer:
- O paciente pode enviar os 3 dados em linhas separadas (nome na 1ª linha, data na 2ª, telefone na 3ª)
- O nome pode ter 2 a 5 palavras, com ou sem preposições (de, da, dos, etc.)
- A data pode vir COM separadores: DD/MM/AAAA, DD-MM-AAAA, DD.MM.AAAA
- A data pode vir SEM separadores: "15091983" = 15/09/1983 | "150983" = 15/09/1983 | "1509983" = 15/09/1983 (interprete com bom senso)
- Sempre retorne a data no formato DD/MM/AAAA
- O telefone pode vir com ou sem DDD, com traços, espaços ou parênteses — retorne SOMENTE os dígitos
- Se o telefone tiver 8 dígitos sem DDD, não invente o DDD

Não inclua explicações, apenas o JSON.`,
    messages: [{ role: 'user', content: message }],
  });

  let extracted = { name: null, birth_date: null, contact_phone: null };
  try {
    let raw = extraction.content[0].text.trim();

    // Remove blocos de código markdown que o modelo às vezes inclui (```json ... ```)
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    extracted = JSON.parse(raw);
    console.log(`🔍 Extração de cadastro:`, JSON.stringify(extracted));
  } catch (e) {
    console.warn(`⚠️ Falha ao parsear JSON do Haiku: "${extraction.content[0]?.text}" — tentando fallback regex`);

    // Fallback: extração direta por regex para o formato de 3 linhas
    const lines = message.trim().split('\n').map(l => l.trim()).filter(Boolean);

    // Data COM separadores: DD/MM/AAAA
    const dateWithSep = /(\d{2})[\/\-\.](\d{2})[\/\-\.](\d{4})/;
    // Data SEM separadores: DDMMYYYY (8 dígitos) ou DDMMYY (6 dígitos) ou typos como 7 dígitos
    const dateNoSep   = /\b(\d{6,8})\b/;
    const phoneRegex  = /(?:\(?\d{2}\)?\s?)?\d{4,5}[\-\s]?\d{4}/;

    const dateMatchSep = message.match(dateWithSep);
    if (dateMatchSep) {
      extracted.birth_date = `${dateMatchSep[1]}/${dateMatchSep[2]}/${dateMatchSep[3]}`;
    } else {
      // Tentar data sem separadores em cada linha
      for (const line of lines) {
        if (/^\d{6,8}$/.test(line)) {
          const d = line.replace(/\D/g, '');
          if (d.length === 8) {
            // DDMMYYYY
            extracted.birth_date = `${d.slice(0,2)}/${d.slice(2,4)}/${d.slice(4,8)}`;
          } else if (d.length === 6) {
            // DDMMYY → assume 1900s ou 2000s
            const yy = parseInt(d.slice(4,6));
            const yyyy = yy > 30 ? `19${d.slice(4,6)}` : `20${d.slice(4,6)}`;
            extracted.birth_date = `${d.slice(0,2)}/${d.slice(2,4)}/${yyyy}`;
          } else if (d.length === 7) {
            // Typo comum: DMMYYYY ou DDMMYYY — tenta DDMMYYYY inserindo dígito
            extracted.birth_date = `${d.slice(0,2)}/${d.slice(2,4)}/19${d.slice(4,7)}`;
          }
          break;
        }
      }
    }

    // Telefone: linha com 10-11 dígitos (DDD + número)
    const phoneMatch = message.match(phoneRegex);
    if (phoneMatch) {
      extracted.contact_phone = phoneMatch[0].replace(/\D/g, '');
    } else {
      for (const line of lines) {
        const digits = line.replace(/\D/g, '');
        if (digits.length >= 10 && digits.length <= 11) {
          extracted.contact_phone = digits;
          break;
        }
      }
    }

    // Nome: primeira linha com 2+ palavras que não seja data nem só números
    for (const line of lines) {
      const digits = line.replace(/\D/g, '');
      if (digits.length < 6 && line.split(' ').length >= 2 && /[a-zA-ZÀ-ú]/.test(line)) {
        extracted.name = line;
        break;
      }
    }
    console.log(`🔍 Extração fallback:`, JSON.stringify(extracted));
  }

  // Merge com o que já temos no banco (coletas parciais anteriores)
  const updatedName         = extracted.name         || patient.name;
  const updatedBirthDate    = extracted.birth_date    || patient.birth_date;
  const updatedContactPhone = extracted.contact_phone || patient.contact_phone;

  // Salvar parcialmente mesmo que incompleto (para próximas mensagens)
  if (extracted.name || extracted.birth_date || extracted.contact_phone) {
    const { queries } = await import('./database.js');
    queries.updatePatient.run({
      id:        patient.id,
      name:      updatedName       || patient.name,
      email:     patient.email,
      specialty: patient.specialty,
      notes:     patient.notes,
    });
    // Salvar campos novos diretamente
    if (extracted.birth_date || extracted.contact_phone) {
      const db = (await import('./database.js')).default;
      db.prepare(`UPDATE patients SET birth_date = COALESCE(@birth_date, birth_date),
                  contact_phone = COALESCE(@contact_phone, contact_phone),
                  updated_at = datetime('now','localtime') WHERE id = @id`)
        .run({ id: patient.id, birth_date: extracted.birth_date, contact_phone: extracted.contact_phone });
    }
  }

  // Verificar quais campos ainda faltam
  const missingFields = [];
  if (!updatedName || updatedName === 'Novo Paciente') missingFields.push('*nome completo*');
  if (!updatedBirthDate) missingFields.push('*data de nascimento* (dd/mm/aaaa)');
  if (!updatedContactPhone) missingFields.push('*número de telefone* para contato');

  if (missingFields.length === 0) {
    // Todos os dados coletados → solicitar consentimento LGPD antes de concluir o cadastro
    console.log(`📋 Dados coletados para ${updatedName} — aguardando consentimento LGPD`);
    const reply = lgpdConsentMessage(updatedName);
    saveMessage(patient.id, 'assistant', reply);
    return reply;
  }

  // Ainda faltam dados — pedir de forma amigável
  const reply = `Obrigada pela resposta! 😊

Para finalizar seu cadastro, ainda preciso de:\n${missingFields.map(f => `• ${f}`).join('\n')}

Pode me informar? 🙏`;
  saveMessage(patient.id, 'assistant', reply);
  return reply;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Detecta se o paciente está confirmando o consentimento LGPD.
 */
function isLgpdConfirmation(message) {
  const text = message.trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /^(sim|s|ok|concordo|aceito|autorizo|de acordo|confirmo|certo|claro|pode|tudo bem)$/.test(text)
    || /concordo|aceito|autorizo/.test(text);
}

/**
 * Detecta se o paciente está perguntando sobre horários disponíveis para agendar.
 * Quando true, Cláudia envia mensagem de espera e ativa o modo humano (Dr. Diego responde).
 */
function isAvailabilityQuestion(message) {
  const text = message
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // remove acentos

  // Não confundir com perguntas sobre horário de funcionamento da clínica
  if (/horario\s*de\s*(funcionamento|atendimento|abertura)/.test(text)) return false;

  return (
    /horario[s]?\s*(disponivel[s]?|livre[s]?|vago[s]?)/.test(text) ||  // "horário disponível/livre/vago"
    /disponivel[s]?\s*horario/.test(text) ||                             // "disponível horário"
    /tem\s+horario[s]?/.test(text) ||                                    // "tem horário"
    /quais?\s*(os\s+)?horario[s]?/.test(text) ||                        // "qual/quais horários"
    /proximo[s]?\s+horario[s]?/.test(text) ||                           // "próximo horário"
    /tem\s+vaga[s]?/.test(text) ||                                       // "tem vaga"
    /vaga[s]?\s*(disponivel[s]?|livre[s]?|aberta[s]?)/.test(text) ||    // "vaga disponível/livre"
    /quando\s+(tem|ha|posso|consigo|da)\s+(horario|agendar|marcar)/.test(text) || // "quando tem horário/posso agendar"
    /agenda\s+(disponivel|livre|aberta)/.test(text)                      // "agenda disponível/livre"
  );
}

/**
 * Verifica se a mensagem é um score de pesquisa de satisfação (1-5).
 */
function extractSurveyScore(message) {
  const trimmed = message.trim();
  if (/^[1-5]$/.test(trimmed)) return trimmed;

  // Também aceita formatos como "4/5", "nota 4", "nota: 4"
  const match = trimmed.match(/(?:nota[:\s]+)?([1-5])(?:\s*\/\s*5)?/i);
  return match ? match[1] : null;
}

