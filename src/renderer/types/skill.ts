// Skill type definition
export interface Skill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;       // Whether visible in popover
  isOfficial: boolean;    // "Official" badge
  isBuiltIn: boolean;     // Bundled with app, cannot be deleted
  updatedAt: number;      // Timestamp
  prompt: string;         // System prompt content
  skillPath: string;      // Absolute path to SKILL.md
  version?: string;       // Skill version from SKILL.md frontmatter
  name_zh?: string;       // Chinese name from SKILL.md frontmatter
  description_zh?: string; // Chinese description from SKILL.md frontmatter
  packId?: string;         // Skill pack group identifier (e.g. source_author)
  author?: string;         // Author name from SKILL.md frontmatter
}

export type LocalizedText = { en: string; zh: string };

export interface MarketTag {
  id: string;
  en: string;
  zh: string;
}

export interface LocalSkillInfo {
  id: string;
  name: string;
  description: string | LocalizedText;
  version: string;
}

export interface MarketplaceSkill {
  id: string;
  name: string;
  name_zh?: string;
  description: string | LocalizedText;
  tags?: string[];
  url: string;              // Download URL (.zip)
  version: string;
  is_official?: boolean;    // Official skill badge from admin
  source: {
    from: string;           // e.g. "Github"
    url: string;            // Source repo URL
    author?: string;        // Author name
  };
}

export interface SkillPack {
  author: string;
  count: number;
  skills: MarketplaceSkill[];
}
