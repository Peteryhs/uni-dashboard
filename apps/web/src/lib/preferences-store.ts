import { useCallback, useEffect, useState } from 'react';

export type LayoutDensity = 'detailed' | 'compact';
export type DietaryPreference = 'all' | 'halal' | 'vegan' | 'vegetarian' | 'dairy' | 'gluten';

export interface UserPreferences {
  density: LayoutDensity;
  dietaryFilter: DietaryPreference;
  favoriteDishes: string[];
  favoriteOutlets: string[];
  dishSearchQuery: string;
  onlyFavorites: boolean;
}

const STORAGE_KEY = 'uni-dashboard:preferences:v1';

const DEFAULT_PREFERENCES: UserPreferences = {
  density: 'detailed',
  dietaryFilter: 'all',
  favoriteDishes: [],
  favoriteOutlets: ['REVelation - Residence Dining Hall', "Mudie's - Residence Dining Hall"],
  dishSearchQuery: '',
  onlyFavorites: false,
};

function readPreferences(): UserPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_PREFERENCES, ...parsed };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function usePreferences() {
  const [preferences, setPreferencesState] = useState<UserPreferences>(() => readPreferences());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      // ignore storage quota errors
    }
  }, [preferences]);

  const setDensity = useCallback((density: LayoutDensity) => {
    setPreferencesState((prev) => ({ ...prev, density }));
  }, []);

  const setDietaryFilter = useCallback((dietaryFilter: DietaryPreference) => {
    setPreferencesState((prev) => ({ ...prev, dietaryFilter }));
  }, []);

  const setDishSearchQuery = useCallback((dishSearchQuery: string) => {
    setPreferencesState((prev) => ({ ...prev, dishSearchQuery }));
  }, []);

  const setOnlyFavorites = useCallback((onlyFavorites: boolean) => {
    setPreferencesState((prev) => ({ ...prev, onlyFavorites }));
  }, []);

  const toggleFavoriteDish = useCallback((dishName: string) => {
    setPreferencesState((prev) => {
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
    setPreferencesState((prev) => {
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

  const resetPreferences = useCallback(() => {
    setPreferencesState(DEFAULT_PREFERENCES);
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
    resetPreferences,
  };
}
