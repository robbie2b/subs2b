set -u
pip install --no-cache-dir -q ffsubsync > /data/pip.log 2>&1; tail -2 /data/pip.log
ffs --version
mkdir -p /data/out
cd /data/corpus
now_ms() { echo $(( $(date +%s%N) / 1000000 )); }
echo "case|candidate|reference|mode|ms|exit" > /data/out/runs.csv
for d in peacemaker hotd_kitsune hotd_remux bigbang andor; do
  mkdir -p /data/out/$d
  for cand in $d/cand_*.srt; do
    for ref in $d/ref_*.srt; do
      cb=$(basename "$cand" .srt | cut -c1-8); rb=$(basename "$ref" .srt | cut -c1-8)
      for mode in plain split; do
        args=""; [ "$mode" = split ] && args="--split-penalty 7"
        out=/data/out/$d/${cb}__${rb}.$mode.srt
        s=$(now_ms)
        ffs "$ref" -i "$cand" -o "$out" $args > /data/out/$d/${cb}__${rb}.$mode.log 2>&1
        rc=$?
        e=$(now_ms)
        echo "$d|$cand|$ref|$mode|$((e-s))|$rc" >> /data/out/runs.csv
      done
    done
  done
  echo "done $d"
done
echo FINISHED
