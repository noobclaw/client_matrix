import { Skill, MarketplaceSkill, MarketTag, LocalSkillInfo, LocalizedText, SkillPack } from '../types/skill';
import { getBackendApiUrl, getSkillStoreUrl } from './endpoints';
import { i18nService } from './i18n';

export function resolveLocalizedText(text: string | LocalizedText): string {
  if (!text) return '';
  if (typeof text === 'string') return text;
  const lang = i18nService.getLanguage();
  return (text as Record<string, string>)[lang] || text.en || '';
}

type EmailConnectivityCheck = {
  code: 'imap_connection' | 'smtp_connection';
  level: 'pass' | 'fail';
  message: string;
  durationMs: number;
};

type EmailConnectivityTestResult = {
  testedAt: number;
  verdict: 'pass' | 'fail';
  checks: EmailConnectivityCheck[];
};

class SkillService {
  private skills: Skill[] = [];
  private initialized = false;
  private localSkillDescriptions: Map<string, string | LocalizedText> = new Map();
  private marketplaceSkillDescriptions: Map<string, string | LocalizedText> = new Map();

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.loadSkills();
    this.initialized = true;
  }

  async loadSkills(): Promise<Skill[]> {
    try {
      const result = await window.electron.skills.list();
      if (result.success && result.skills) {
        this.skills = result.skills;
      } else {
        this.skills = [];
      }
      return this.skills;
    } catch (error) {
      console.error('Failed to load skills:', error);
      this.skills = [];
      return this.skills;
    }
  }

  async setSkillEnabled(id: string, enabled: boolean): Promise<Skill[]> {
    try {
      const result = await window.electron.skills.setEnabled({ id, enabled });
      if (result.success && result.skills) {
        this.skills = result.skills;
        return this.skills;
      }
      throw new Error(result.error || 'Failed to update skill');
    } catch (error) {
      console.error('Failed to update skill:', error);
      throw error;
    }
  }

  async deleteSkill(id: string): Promise<{ success: boolean; skills?: Skill[]; error?: string }> {
    try {
      const result = await window.electron.skills.delete(id);
      if (result.success && result.skills) {
        this.skills = result.skills;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete skill';
      console.error('Failed to delete skill:', error);
      return { success: false, error: message };
    }
  }

  async downloadSkill(source: string, meta?: { official?: boolean; skillId?: string }): Promise<{ success: boolean; skills?: Skill[]; error?: string }> {
    try {
      // Resolve relative URLs (e.g. /uploads/skills/...) to full backend URLs
      let resolvedSource = source;
      if (source.startsWith('/')) {
        resolvedSource = `${getBackendApiUrl()}${source}`;
      }
      const result = await window.electron.skills.download(resolvedSource, meta);
      if (result.success && result.skills) {
        this.skills = result.skills;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to download skill';
      console.error('Failed to download skill:', error);
      return { success: false, error: message };
    }
  }

  async getSkillsRoot(): Promise<string | null> {
    try {
      const result = await window.electron.skills.getRoot();
      if (result.success && result.path) {
        return result.path;
      }
      return null;
    } catch (error) {
      console.error('Failed to get skills root:', error);
      return null;
    }
  }

  onSkillsChanged(callback: () => void): () => void {
    return window.electron.skills.onChanged(callback);
  }

  getSkills(): Skill[] {
    return this.skills;
  }

  getEnabledSkills(): Skill[] {
    return this.skills.filter(s => s.enabled);
  }

  getSkillById(id: string): Skill | undefined {
    return this.skills.find(s => s.id === id);
  }

  async getSkillConfig(skillId: string): Promise<Record<string, string>> {
    try {
      const result = await window.electron.skills.getConfig(skillId);
      if (result.success && result.config) {
        return result.config;
      }
      return {};
    } catch (error) {
      console.error('Failed to get skill config:', error);
      return {};
    }
  }

  async setSkillConfig(skillId: string, config: Record<string, string>): Promise<boolean> {
    try {
      const result = await window.electron.skills.setConfig(skillId, config);
      return result.success;
    } catch (error) {
      console.error('Failed to set skill config:', error);
      return false;
    }
  }

  async testEmailConnectivity(
    skillId: string,
    config: Record<string, string>
  ): Promise<EmailConnectivityTestResult | null> {
    try {
      const result = await window.electron.skills.testEmailConnectivity(skillId, config);
      if (result.success && result.result) {
        return result.result;
      }
      return null;
    } catch (error) {
      console.error('Failed to test email connectivity:', error);
      return null;
    }
  }

  async getAutoRoutingPrompt(): Promise<string | null> {
    try {
      const result = await window.electron.skills.autoRoutingPrompt();
      return result.success ? (result.prompt || null) : null;
    } catch (error) {
      console.error('Failed to get auto-routing prompt:', error);
      return null;
    }
  }
  async fetchMarketplaceSkills(options?: {
    page?: number;
    pageSize?: number;
    tag?: string;
    search?: string;
  }): Promise<{
    skills: MarketplaceSkill[];
    tags: MarketTag[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number; hasMore: boolean };
  }> {
    const emptyPagination = { page: 1, pageSize: 20, total: 0, totalPages: 0, hasMore: false };
    try {
      const params = new URLSearchParams();
      if (options?.page) params.set('page', String(options.page));
      if (options?.pageSize) params.set('pageSize', String(options.pageSize));
      if (options?.tag) params.set('tag', options.tag);
      if (options?.search) params.set('search', options.search);
      const qs = params.toString();
      const url = qs ? `${getSkillStoreUrl()}?${qs}` : getSkillStoreUrl();

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const json = await response.json();
      const value = json?.data?.value;
      // Store local skill descriptions for i18n lookup
      const localSkills: LocalSkillInfo[] = Array.isArray(value?.localSkill) ? value.localSkill : [];
      this.localSkillDescriptions.clear();
      for (const ls of localSkills) {
        this.localSkillDescriptions.set(ls.name, ls.description);
      }
      const skills: MarketplaceSkill[] = Array.isArray(value?.marketplace) ? value.marketplace : [];
      const tags: MarketTag[] = Array.isArray(value?.marketTags) ? value.marketTags : [];
      const pagination = value?.pagination || emptyPagination;
      // Also store marketplace skill descriptions for i18n lookup (keyed by id)
      for (const ms of skills) {
        if (typeof ms.description === 'object') {
          this.marketplaceSkillDescriptions.set(ms.id, ms.description);
        }
      }
      return { skills, tags, pagination };
    } catch (error) {
      console.error('Failed to fetch marketplace skills:', error);
      return { skills: [], tags: [], pagination: emptyPagination };
    }
  }

  async fetchSkillPacks(): Promise<SkillPack[]> {
    try {
      const url = `${getSkillStoreUrl()}/packs`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      return Array.isArray(json?.packs) ? json.packs : [];
    } catch (error) {
      console.error('Failed to fetch skill packs:', error);
      return [];
    }
  }

  getLocalizedSkillDescription(skillId: string, skillName: string, fallback: string, skill?: Skill): string {
    // If language is 'zh' and the skill has a description_zh field, use it
    if (skill?.description_zh && i18nService.getLanguage() === 'zh') {
      return skill.description_zh;
    }
    const localDesc = this.localSkillDescriptions.get(skillName);
    if (localDesc != null) return resolveLocalizedText(localDesc);
    const marketDesc = this.marketplaceSkillDescriptions.get(skillId);
    if (marketDesc != null) return resolveLocalizedText(marketDesc);
    return fallback;
  }

  getLocalizedSkillName(skill: { name: string; name_zh?: string }): string {
    if (skill.name_zh && i18nService.getLanguage() === 'zh') {
      return skill.name_zh;
    }
    return skill.name;
  }
}

export const skillService = new SkillService();
