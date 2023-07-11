<!DOCTYPE html>
<html>
<head>
  <title>Alert Simulator</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 0;
      padding: 0;
      text-align: center;
    }

    h1 {
      margin-top: 50px;
    }

    .container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
    }

    .button-container {
      margin-top: 20px;
    }

    .button {
      padding: 10px 20px;
      font-size: 16px;
      cursor: pointer;
      background-color: green;
      color: white;
      border: none;
      border-radius: 4px;
      transition: background-color 0.3s ease;
    }

    .button:hover {
      background-color: darkgreen;
    }

    @media only screen and (max-width: 600px) {
      h1 {
        font-size: 24px;
      }

      .button {
        font-size: 14px;
      }
    }
  </style>
  <script type="text/javascript">
    function sendEmailNotification() {
      // Simulate sending an email notification
      console.log("Email notification sent!");
      alert("Email notification sent!"); // Display an alert to simulate the email notification
    }
  </script>
</head>
<body>
  <div class="container">
    <h1>Alert Simulator</h1>
    <p>This page is used for email alert simulation. Click on the button to generate the alert.</p>
    <div class="button-container">
      <button class="button" onclick="sendEmailNotification()">Send Email Notification</button>
    </div>
  </div>
</body>
</html>
