import { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import { WorkoutExercise, SetLog } from '../../types/workout';
import { colors, radius, spacing } from '../../theme/tokens';

interface ExerciseCardProps {
  exercise: WorkoutExercise;
  loggedSets: SetLog[];
  onLogSet: (setNumber: number, weightKg: number, reps: number) => Promise<void>;
}

export function ExerciseCard({ exercise, loggedSets, onLogSet }: ExerciseCardProps) {
  const [weight, setWeight] = useState(
    exercise.suggestedWeightKg !== null ? String(exercise.suggestedWeightKg) : ''
  );
  const [reps, setReps] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nextSetNumber = loggedSets.length + 1;
  const isComplete = loggedSets.length >= exercise.sets;

  const handleSave = async () => {
    setError(null);
    const weightNum = Number(weight);
    const repsNum = Number(reps);

    if (!weight || Number.isNaN(weightNum) || weightNum <= 0) {
      setError('Escribe el peso');
      return;
    }
    if (!reps || Number.isNaN(repsNum) || repsNum <= 0) {
      setError('Escribe las repeticiones');
      return;
    }

    setSaving(true);
    try {
      await onLogSet(nextSetNumber, weightNum, repsNum);
      setReps('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={[styles.card, isComplete && styles.cardComplete]}>
      <View style={styles.header}>
        <Text style={styles.name}>{exercise.name}</Text>
        {isComplete && <Text style={styles.check}>✓</Text>}
      </View>

      <Text style={styles.target}>
        {exercise.sets} series · {exercise.repMin}-{exercise.repMax} reps · descanso{' '}
        {exercise.restSeconds >= 60
          ? `${Math.round(exercise.restSeconds / 60)} min`
          : `${exercise.restSeconds} s`}
      </Text>

      <Text style={styles.note}>{exercise.progressionNote}</Text>

      {loggedSets.length > 0 && (
        <View style={styles.setsRow}>
          {loggedSets.map((s) => (
            <View key={s.set_number} style={styles.setChip}>
              <Text style={styles.setChipText}>
                {s.weight_kg}×{s.reps}
              </Text>
            </View>
          ))}
        </View>
      )}

      {!isComplete && (
        <View style={styles.inputRow}>
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>kg</Text>
            <TextInput
              style={styles.input}
              keyboardType="decimal-pad"
              value={weight}
              onChangeText={setWeight}
              placeholder="0"
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>reps</Text>
            <TextInput
              style={styles.input}
              keyboardType="number-pad"
              value={reps}
              onChangeText={setReps}
              placeholder="0"
            />
          </View>

          <Pressable
            onPress={handleSave}
            disabled={saving}
            accessibilityRole="button"
            accessibilityLabel={`Guardar serie ${nextSetNumber} de ${exercise.name}`}
            style={({ pressed }) => [
              styles.saveButton,
              saving && styles.saveButtonDisabled,
              pressed && styles.saveButtonPressed,
            ]}
          >
            <Text style={styles.saveButtonText}>
              {saving ? '...' : `Serie ${nextSetNumber}`}
            </Text>
          </Pressable>
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  cardComplete: { opacity: 0.6 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  name: { fontSize: 17, fontWeight: '600', color: colors.textPrimary, flex: 1 },
  check: { fontSize: 18, color: '#34C759', fontWeight: '700' },
  target: { fontSize: 12, color: colors.textTertiary, marginTop: 4 },
  note: {
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: spacing.sm,
    lineHeight: 18,
  },
  setsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: spacing.md },
  setChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.sm,
    backgroundColor: colors.background,
  },
  setChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textSecondary,
    fontVariant: ['tabular-nums'],
  },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, marginTop: spacing.md },
  inputGroup: { flex: 1 },
  inputLabel: { fontSize: 11, color: colors.textTertiary, marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    color: colors.textPrimary,
  },
  saveButton: {
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    minWidth: 90,
    alignItems: 'center',
  },
  saveButtonDisabled: { opacity: 0.5 },
  saveButtonPressed: { opacity: 0.8 },
  saveButtonText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  error: { color: colors.danger, fontSize: 12, marginTop: spacing.sm },
});
