export type ContractFormat = 'json';

export interface OutputContract {
  schemaName: string;
  format: ContractFormat;
  required: string[];
  schema: Record<string, any>;
}

export interface ContractValidationResult {
  valid: boolean;
  errors: string[];
}

export const PLANNER_OUTPUT_CONTRACT: OutputContract = {
  schemaName: 'PlannerOutput',
  format: 'json',
  required: ['summary', 'topology', 'graph'],
  schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      topology: {
        type: 'object',
        properties: {
          serialStages: { type: 'number' },
          parallelBranches: { type: 'number' },
        },
        required: ['serialStages', 'parallelBranches'],
      },
      graph: { type: 'object' },
    },
  },
};

export const BROWSER_RESEARCH_OUTPUT_CONTRACT: OutputContract = {
  schemaName: 'BrowserResearchOutput',
  format: 'json',
  required: ['findings'],
  schema: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            url: { type: 'string' },
            facts: { type: 'array', items: { type: 'string' } },
            confidence: { type: 'number' },
          },
          required: ['title', 'url', 'facts', 'confidence'],
        },
      },
      recommendedNextUrls: { type: 'array', items: { type: 'string' } },
      blockers: { type: 'array', items: { type: 'string' } },
    },
  },
};

export const PRODUCT_COMPARE_OUTPUT_CONTRACT: OutputContract = {
  schemaName: 'ProductCompareOutput',
  format: 'json',
  required: ['products'],
  schema: {
    type: 'object',
    properties: {
      products: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            url: { type: 'string' },
            price: { type: 'string' },
            rating: { type: 'string' },
            reviewCount: { type: 'string' },
            pros: { type: 'array', items: { type: 'string' } },
            cons: { type: 'array', items: { type: 'string' } },
          },
          required: ['title', 'url', 'pros', 'cons'],
        },
      },
      winner: { type: 'string' },
      rationale: { type: 'string' },
    },
  },
};

export const APP_TASK_OUTPUT_CONTRACT: OutputContract = {
  schemaName: 'AppTaskOutput',
  format: 'json',
  required: ['appId', 'actionLog', 'artifacts', 'stateSummary'],
  schema: {
    type: 'object',
    properties: {
      appId: { type: 'string' },
      actionLog: { type: 'array', items: { type: 'string' } },
      artifacts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            kind: { type: 'string' },
          },
          required: ['path', 'kind'],
        },
      },
      stateSummary: { type: 'string' },
      blockers: { type: 'array', items: { type: 'string' } },
    },
  },
};

export const VERIFICATION_OUTPUT_CONTRACT: OutputContract = {
  schemaName: 'VerificationOutput',
  format: 'json',
  required: ['passed', 'checks', 'retryRecommended'],
  schema: {
    type: 'object',
    properties: {
      passed: { type: 'boolean' },
      checks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            passed: { type: 'boolean' },
            detail: { type: 'string' },
          },
          required: ['name', 'passed', 'detail'],
        },
      },
      retryRecommended: { type: 'boolean' },
    },
  },
};

export function validateContractPayload(contract: OutputContract, payload: unknown): ContractValidationResult {
  const errors: string[] = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    errors.push('$ expected object');
    return { valid: false, errors };
  }
  const record = payload as Record<string, unknown>;
  for (const key of contract.required || []) {
    if (!(key in record)) errors.push(`$.${key} missing`);
  }
  validateSchemaValue(contract.schema, payload, '$', errors);
  return { valid: errors.length === 0, errors };
}

function validateSchemaValue(schema: any, value: unknown, path: string, errors: string[]): void {
  if (!schema || typeof schema !== 'object') return;

  const schemaType = schema.type;
  if (schemaType === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path} expected object`);
      return;
    }
    const record = value as Record<string, unknown>;
    for (const key of schema.required || []) {
      if (!(key in record)) errors.push(`${path}.${key} missing`);
    }
    const properties = schema.properties || {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in record) validateSchemaValue(childSchema, record[key], `${path}.${key}`, errors);
    }
    return;
  }

  if (schemaType === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path} expected array`);
      return;
    }
    if (schema.items) {
      value.forEach((item, index) => validateSchemaValue(schema.items, item, `${path}[${index}]`, errors));
    }
    return;
  }

  if (schemaType === 'string' && typeof value !== 'string') {
    errors.push(`${path} expected string`);
    return;
  }

  if (schemaType === 'number' && typeof value !== 'number') {
    errors.push(`${path} expected number`);
    return;
  }

  if (schemaType === 'boolean' && typeof value !== 'boolean') {
    errors.push(`${path} expected boolean`);
  }
}
