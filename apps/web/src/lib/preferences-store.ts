import { useCallback, useSyncExternalStore } from 'react';

export type LayoutDensity = 'detailed' | 'compact';
export type DietaryPreference = 'all' | 'halal' | 'vegan' | 'vegetarian' | 'dairy' | 'gluten';
export type SpiceLevel = 'none' | 'mild' | 'medium' | 'hot' | 'extra-hot';

export interface TasteProfile {
  bio: string;
  spiceLevel: SpiceLevel;
  dietaryGoals: string[];
  selectedAiModel: string;
  sortByAiRank: boolean;
}

export const DEFAULT_TASTE_PROFILE: TasteProfile = {
  bio: '',
  spiceLevel: 'medium',
  dietaryGoals: ['high-protein'],
  selectedAiModel: '@cf/google/gemma-4-26b-a4b-it',
  sortByAiRank: true,
};

export interface UserPreferences {
  density: LayoutDensity;
  dietaryFilter: DietaryPreference;
  favoriteDishes: string[];
  favoriteOutlets: string[];
  dishSearchQuery: string;
  onlyFavorites: boolean;
  tasteProfile: TasteProfile;
  dismissedTasks: string[];
  section: number | null;
  groupNumber: number | null;
}

const STORAGE_KEY = 'uni-dashboard:preferences:v3';

const DEFAULT_PREFERENCES: UserPreferences = {
  density: 'detailed',
  dietaryFilter: 'all',
  favoriteDishes: [],
  favoriteOutlets: ['REVelation - Residence Dining Hall', "Mudie's - Residence Dining Hall"],
  dishSearchQuery: '',
  onlyFavorites: false,
  tasteProfile: DEFAULT_TASTE_PROFILE,
  dismissedTasks: [],
  section: null,
  groupNumber: null,
};

function readPreferences(): UserPreferences {
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY) ||
      localStorage.getItem('uni-dashboard:preferences:v2') ||
      localStorage.getItem('uni-dashboard:preferences:v1');
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_PREFERENCES,
      ...parsed,
      dismissedTasks: Array.isArray(parsed.dismissedTasks) ? parsed.dismissedTasks : [],
      section: typeof parsed.section === 'number' ? parsed.section : null,
      groupNumber: typeof parsed.groupNumber === 'number' ? parsed.groupNumber : null,
      tasteProfile: {
        ...DEFAULT_TASTE_PROFILE,
        ...(parsed.tasteProfile || {}),
      },
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

// Module-level singleton store for instant cross-component synchronization
let currentPreferences: UserPreferences = readPreferences();
const listeners = new Set<() => void>();

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): UserPreferences {
  return currentPreferences;
}

function getServerSnapshot(): UserPreferences {
  return DEFAULT_PREFERENCES;
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (
      event.key === STORAGE_KEY ||
      event.key === 'uni-dashboard:preferences:v2' ||
      event.key === 'uni-dashboard:preferences:v1'
    ) {
      currentPreferences = readPreferences();
      emitChange();
    }
  });
}

function setPreferences(updater: (prev: UserPreferences) => UserPreferences) {
  currentPreferences = updater(currentPreferences);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(currentPreferences));
  } catch {
    // ignore storage quota errors
  }
  emitChange();
}

export function usePreferences() {
  const preferences = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setDensity = useCallback((density: LayoutDensity) => {
    setPreferences((prev) => ({ ...prev, density }));
  }, []);

  const setDietaryFilter = useCallback((dietaryFilter: DietaryPreference) => {
    setPreferences((prev) => ({ ...prev, dietaryFilter }));
  }, []);

  const setDishSearchQuery = useCallback((dishSearchQuery: string) => {
    setPreferences((prev) => ({ ...prev, dishSearchQuery }));
  }, []);

  const setOnlyFavorites = useCallback((onlyFavorites: boolean) => {
    setPreferences((prev) => ({ ...prev, onlyFavorites }));
  }, []);

  const toggleFavoriteDish = useCallback((dishName: string) => {
    setPreferences((prev) => {
      const normalized = dishName.trim().toLowerCase();
      const exists = prev.favoriteDishes.some((d) => d.toLowerCase() === normalized);
      return {
        ...prev,
        favoriteDishes: exists
          ? prev.favoriteDishes.filter((d) => d.toLowerCase() !== normalized)
          : [...prev.favoriteDishes, dishName.trim()],
      };
    });
  }, []);

  const isFavoriteDish = useCallback(
    (dishName: string) => {
      const normalized = dishName.trim().toLowerCase();
      return preferences.favoriteDishes.some((d) => d.toLowerCase() === normalized);
    },
    [preferences.favoriteDishes],
  );

  const toggleFavoriteOutlet = useCallback((outletName: string) => {
    setPreferences((prev) => {
      const exists = prev.favoriteOutlets.includes(outletName);
      return {
        ...prev,
        favoriteOutlets: exists
          ? prev.favoriteOutlets.filter((o) => o !== outletName)
          : [...prev.favoriteOutlets, outletName],
      };
    });
  }, []);

  const isFavoriteOutlet = useCallback(
    (outletName: string) => preferences.favoriteOutlets.includes(outletName),
    [preferences.favoriteOutlets],
  );

  const updateTasteProfile = useCallback((patch: Partial<TasteProfile>) => {
    setPreferences((prev) => ({
      ...prev,
      tasteProfile: {
        ...prev.tasteProfile,
        ...patch,
      },
    }));
  }, []);

  const dismissTask = useCallback((id: string) => {
    if (!id) return;
    setPreferences((prev) => {
      if (prev.dismissedTasks.includes(id)) return prev;
      return { ...prev, dismissedTasks: [...prev.dismissedTasks, id] };
    });
  }, []);

  const undismissTask = useCallback((id: string) => {
    if (!id) return;
    setPreferences((prev) => ({
      ...prev,
      dismissedTasks: prev.dismissedTasks.filter((t) => t !== id),
    }));
  }, []);

  const isDismissed = useCallback(
    (id: string) => Boolean(id && preferences.dismissedTasks.includes(id)),
    [preferences.dismissedTasks],
  );

  const setSection = useCallback((section: number | null) => {
    setPreferences((prev) => ({ ...prev, section }));
  }, []);

  const setGroupNumber = useCallback((groupNumber: number | null) => {
    setPreferences((prev) => ({ ...prev, groupNumber }));
  }, []);

  const resetPreferences = useCallback(() => {
    setPreferences(() => DEFAULT_PREFERENCES);
  }, []);

  return {
    preferences,
    setDensity,
    setDietaryFilter,
    setDishSearchQuery,
    setOnlyFavorites,
    toggleFavoriteDish,
    isFavoriteDish,
    toggleFavoriteOutlet,
    isFavoriteOutlet,
    updateTasteProfile,
    dismissTask,
    undismissTask,
    isDismissed,
    setSection,
    setGroupNumber,
    resetPreferences,
  };
}
