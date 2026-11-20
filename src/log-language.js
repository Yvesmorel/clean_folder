// Older versions saved a few built-in progress messages in French. Translate only
// those known messages for display; filenames and the stored history stay intact.
export function englishLogMessage(message) {
  return message
    .replace(/^Lecture des indices : (\d+\/\d+)$/, 'Reading content clues: $1')
    .replace(/^Comparaison des fichiers : (\d+\/\d+)$/, 'Comparing files: $1')
    .replace(/^Extraits lus : (\d+)\. Sans extrait : (\d+)\.$/, 'Excerpts read: $1. Without excerpts: $2.')
    .replace(/^Création du plan annulée\. Aucun fichier déplacé\.$/, 'Plan creation cancelled. No files were moved.');
}
