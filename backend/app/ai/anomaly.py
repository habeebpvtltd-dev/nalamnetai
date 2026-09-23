"""
Anomaly detection for utility bills: flags unusually high amounts
using plain statistics — no LLM needed here.
"""
import statistics

ANOMALY_PERCENT_THRESHOLD = 0.30
ANOMALY_STDDEV_THRESHOLD = 2.0


def check_bill_anomaly(current_amount: float, historical_amounts: list[float]) -> dict:
    """historical_amounts: past 'amount' values for this household."""
    if len(historical_amounts) < 2:
        return {"is_anomaly": False, "reason": None, "average": None, "percent_above_average": None}

    avg = statistics.mean(historical_amounts)
    stdev = statistics.stdev(historical_amounts)
    percent_above = ((current_amount - avg) / avg) if avg > 0 else 0

    exceeds_percent = percent_above > ANOMALY_PERCENT_THRESHOLD
    exceeds_stddev = stdev > 0 and (current_amount - avg) > (ANOMALY_STDDEV_THRESHOLD * stdev)

    if exceeds_percent or exceeds_stddev:
        reason = f"This bill is {round(percent_above * 100, 1)}% above your usual average."
        return {
            "is_anomaly": True, "reason": reason,
            "average": round(avg, 2), "percent_above_average": round(percent_above * 100, 2),
        }

    return {
        "is_anomaly": False, "reason": None,
        "average": round(avg, 2), "percent_above_average": round(percent_above * 100, 2),
    }