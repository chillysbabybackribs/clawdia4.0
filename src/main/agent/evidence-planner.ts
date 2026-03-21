export type EvidenceType =
  | 'official_product_pages'
  | 'expert_reviews'
  | 'pricing'
  | 'user_sentiment'
  | 'images'
  | 'videos'
  | 'academic_sources';

export interface EvidencePlan {
  required: EvidenceType[];
  optional: EvidenceType[];
  rationale: string[];
}

const PRODUCT_RE = /\b(product|products|keyboard|keyboards|headset|headsets|laptop|laptops|monitor|monitors|mouse|mice|buy|office keyboard|office keyboards)\b/i;
const REVIEW_RE = /\b(review|reviews|rating|ratings|best|recommend|research)\b/i;
const SENTIMENT_RE = /\b(reddit|forum|forums|sentiment|user sentiment|user reviews?|customer reviews?)\b/i;
const IMAGE_RE = /\b(image|images|photo|photos|picture|pictures)\b/i;
const VIDEO_RE = /\b(video|videos|youtube)\b/i;
const ACADEMIC_RE = /\b(white ?paper|whitepaper|paper|papers|study|studies|research paper|academic)\b/i;

export function buildEvidencePlan(task: string): EvidencePlan {
  const required = new Set<EvidenceType>();
  const optional = new Set<EvidenceType>();
  const rationale: string[] = [];

  if (PRODUCT_RE.test(task)) {
    required.add('official_product_pages');
    rationale.push('Product-oriented task: include official product pages or direct product listings.');
  }

  if (REVIEW_RE.test(task)) {
    required.add('expert_reviews');
    rationale.push('Evaluation-oriented task: include expert review sources, not just commerce listings.');
  }

  if (/\b(price|pricing|under \$|\$\d+)\b/i.test(task)) {
    required.add('pricing');
    rationale.push('Budget or buying task: include current pricing evidence.');
  }

  if (SENTIMENT_RE.test(task)) {
    required.add('user_sentiment');
    rationale.push('Task explicitly asks for user sentiment or forum-style evidence.');
  } else if (required.has('expert_reviews') && required.has('official_product_pages')) {
    optional.add('user_sentiment');
    rationale.push('User sentiment can strengthen a buying recommendation but is not mandatory by default.');
  }

  if (IMAGE_RE.test(task)) {
    required.add('images');
    rationale.push('Task explicitly asks for image evidence.');
  }

  if (VIDEO_RE.test(task)) {
    required.add('videos');
    rationale.push('Task explicitly asks for video evidence.');
  }

  if (ACADEMIC_RE.test(task)) {
    required.add('academic_sources');
    rationale.push('Task explicitly asks for papers, white papers, or studies.');
  }

  return {
    required: [...required],
    optional: [...optional].filter((item) => !required.has(item)),
    rationale,
  };
}
