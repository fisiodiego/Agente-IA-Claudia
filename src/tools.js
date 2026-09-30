// ─── Definições de Tools para Claude API (tool_use) ────────────────────────────
// Cada tool mapeia para um endpoint do CRM Holiz

export const CRM_TOOLS = [
  {
    name: 'list_professionals',
    description: 'Lista os profissionais ativos da clínica com nome e especialidade. Use quando o paciente perguntar quais profissionais estão disponíveis ou quando precisar do ID de um profissional para agendar.',
    input_schema: {
      type: 'object',
      properties: {
        specialty: {
          type: 'string',
          description: 'Filtrar por especialidade (opcional): osteopatia, quiropraxia, psicologia',
          enum: ['osteopatia', 'quiropraxia', 'psicologia'],
        },
      },
      required: [],
    },
  },
  {
    name: 'check_availability',
    description: 'Consulta os horários disponíveis de um profissional em uma data específica. Retorna uma lista de horários livres. Use quando o paciente quiser saber horários disponíveis ou quando precisar verificar se um horário está livre antes de agendar.',
    input_schema: {
      type: 'object',
      properties: {
        professionalId: {
          type: 'string',
          description: 'ID do profissional (obtido via list_professionals)',
        },
        date: {
          type: 'string',
          description: 'Data desejada no formato YYYY-MM-DD',
        },
        duration: {
          type: 'number',
          description: 'Duração da consulta em minutos (padrão: 60)',
        },
      },
      required: ['professionalId', 'date'],
    },
  },
  {
    name: 'find_or_create_patient',
    description: 'Busca um paciente pelo telefone no CRM. Se não existir, cria um novo cadastro. Use antes de criar um agendamento para obter o patientId.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Nome completo do paciente',
        },
        phone: {
          type: 'string',
          description: 'Telefone do paciente (apenas dígitos)',
        },
        birthDate: {
          type: 'string',
          description: 'Data de nascimento no formato YYYY-MM-DD (opcional)',
        },
        email: {
          type: 'string',
          description: 'Email do paciente (opcional)',
        },
      },
      required: ['name', 'phone'],
    },
  },
  {
    name: 'create_appointment',
    description: 'Cria um novo agendamento no CRM. Valida automaticamente: disponibilidade do profissional, conflitos de horário e bloqueios de agenda. Use após confirmar com o paciente o horário desejado. Se o paciente já tem consulta futura ativa, bloqueia (EXISTING_APPOINTMENT na mesma data, FUTURE_APPOINTMENT_EXISTS em outra) até ficar claro se é TROCA (reschedule_appointment) ou sessão A MAIS (additionalSession=true).',
    input_schema: {
      type: 'object',
      properties: {
        patientId: {
          type: 'string',
          description: 'ID do paciente (obtido via find_or_create_patient)',
        },
        professionalId: {
          type: 'string',
          description: 'ID do profissional (obtido via list_professionals)',
        },
        date: {
          type: 'string',
          description: 'Data do agendamento no formato YYYY-MM-DD',
        },
        time: {
          type: 'string',
          description: 'Horário do agendamento no formato HH:MM (ex: 09:00, 14:30)',
        },
        duration: {
          type: 'number',
          description: 'Duração em minutos (padrão: 60)',
        },
        notes: {
          type: 'string',
          description: 'Observações sobre o agendamento (opcional)',
        },
        forceCreate: {
          type: 'boolean',
          description: 'Use APENAS após paciente confirmar EXPLICITAMENTE que quer outro agendamento na mesma data, além de um existente (ex: pacote intensivo com 2 consultas no mesmo dia). Pula o guard EXISTING_APPOINTMENT. NÃO use pra reagendamento — use reschedule_appointment. Não vale para consulta em OUTRA data (isso é additionalSession). Sem "a mais" nas falas nem resposta à pergunta, o sistema ignora a flag.',
        },
        additionalSession: {
          type: 'boolean',
          description: 'Use quando o PACIENTE disse que quer uma sessão A MAIS, além da(s) consulta(s) futura(s) que já tem em OUTRA data (ex: "mais uma", "também quero", "as 5 sessões do plano"), inclusive respondendo "as duas" à pergunta "trocar ou ficar com as duas?". Nunca só porque o sistema bloqueou, nem para troca (troca = reschedule_appointment). Sem "a mais" nas falas nem resposta à pergunta, o sistema ignora a flag.',
        },
      },
      required: ['patientId', 'professionalId', 'date', 'time'],
    },
  },
  {
    name: 'cancel_appointment',
    description: 'Cancela um agendamento existente. Use quando o paciente solicitar cancelamento de uma consulta.',
    input_schema: {
      type: 'object',
      properties: {
        appointmentId: {
          type: 'string',
          description: 'ID do agendamento a ser cancelado (obtido via get_patient_appointments)',
        },
        reason: {
          type: 'string',
          description: 'Motivo do cancelamento (opcional)',
        },
      },
      required: ['appointmentId'],
    },
  },
  {
    name: 'reschedule_appointment',
    description: 'Reagenda um agendamento existente para nova data e/ou horário. Valida automaticamente disponibilidade e conflitos. Use quando o paciente quiser mudar a data ou horário de uma consulta já agendada, em vez de cancelar e criar um novo. Use SÓ quando o paciente pediu para TROCAR/remarcar essa consulta: se ele quer uma sessão A MAIS, NÃO mova a que já existe (use create_appointment com additionalSession=true); se não ficou claro, pergunte antes. Mudar a DATA sem pedido de troca volta RESCHEDULE_NEEDS_CONFIRMATION; com outra consulta dele recém-liberada (Cancelar/Reagendar), REPOSICAO_PENDENTE. Nos dois casos, pergunte ao paciente.',
    input_schema: {
      type: 'object',
      properties: {
        appointmentId: {
          type: 'string',
          description: 'ID do agendamento a ser reagendado (obtido via get_patient_appointments)',
        },
        newDate: {
          type: 'string',
          description: 'Nova data no formato YYYY-MM-DD',
        },
        newTime: {
          type: 'string',
          description: 'Novo horário no formato HH:MM (ex: 09:00, 14:30)',
        },
        duration: {
          type: 'number',
          description: 'Nova duração em minutos (opcional, mantém a anterior se não informado)',
        },
      },
      required: ['appointmentId', 'newDate', 'newTime'],
    },
  },
  {
    name: 'request_reschedule',
    description: 'Use quando o paciente pedir para REAGENDAR/REMARCAR a consulta mas AINDA NÃO informar o novo dia/horário (ex: "preciso remarcar", "vou ter que reagendar pra outra semana", "não vou conseguir ir, quero mudar"). Cancela a consulta atual (LIBERA o horário na agenda) e registra o pedido de reagendamento. DEPOIS de chamar, pergunte ao paciente qual o novo dia e turno. Quando ele informar, use create_appointment para criar a nova consulta. IMPORTANTE: NÃO use esta tool se o paciente JÁ informou o novo dia/horário na mesma mensagem — nesse caso use reschedule_appointment diretamente. Se ele tem MAIS de uma consulta futura, passe appointmentId (sem ele, nada é cancelado e a tool pede para perguntar qual).',
    input_schema: {
      type: 'object',
      properties: {
        phone: {
          type: 'string',
          description: 'Telefone do paciente (apenas dígitos)',
        },
        appointmentId: {
          type: 'string',
          description: 'ID da consulta que o paciente quer remarcar (obrigatório na prática quando ele tem mais de uma consulta futura; obtido via get_patient_appointments)',
        },
      },
      required: ['phone'],
    },
  },
  {
    name: 'get_patient_appointments',
    description: 'Lista os agendamentos futuros de um paciente. Use quando o paciente perguntar sobre suas próximas consultas ou quando precisar encontrar um agendamento para cancelar ou reagendar.',
    input_schema: {
      type: 'object',
      properties: {
        phone: {
          type: 'string',
          description: 'Telefone do paciente (apenas dígitos)',
        },
      },
      required: ['phone'],
    },
  },
  {
    name: 'get_patient_packages',
    description: 'Lista os pacotes de tratamento ativos de um paciente (ex: Osteopatia 5 sessões). Use ANTES de agendar para verificar se o paciente possui pacote ativo — se tiver, o agendamento será vinculado automaticamente ao pacote.',
    input_schema: {
      type: 'object',
      properties: {
        phone: {
          type: 'string',
          description: 'Telefone do paciente (apenas dígitos)',
        },
      },
      required: ['phone'],
    },
  },
  {
    name: 'add_to_waitlist',
    description: 'Adiciona um paciente à lista de espera para uma data e profissional específicos. Use quando não houver horários disponíveis e o paciente quiser ser notificado caso abra uma vaga.',
    input_schema: {
      type: 'object',
      properties: {
        patientId: {
          type: 'string',
          description: 'ID do paciente (obtido via find_or_create_patient)',
        },
        professionalId: {
          type: 'string',
          description: 'ID do profissional',
        },
        preferredDate: {
          type: 'string',
          description: 'Data preferida no formato YYYY-MM-DD',
        },
        preferredPeriod: {
          type: 'string',
          description: 'Período preferido: manha, tarde, qualquer',
          enum: ['manha', 'tarde', 'qualquer'],
        },
      },
      required: ['patientId', 'professionalId', 'preferredDate'],
    },
  },
];
