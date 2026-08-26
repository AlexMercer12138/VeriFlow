`timescale 1ns/1ns

module specify_buffer(input source, output destination);
  buf (destination, source);
  specify
    specparam rise_delay = 5, fall_delay = 5;
    (source => destination) = (rise_delay, fall_delay);
  endspecify
endmodule

module specify_bench;
  integer i;
  reg source;
  reg previous;
  wire destination;

  specify_buffer dut(.source(source), .destination(destination));

  initial begin
    source = 0;
    #6;
    for (i = 0; i < 20000; i = i + 1) begin
      previous = source;
      source = ~source;
      #1;
      if (destination !== previous) begin
        $display("FAIL specify before path delay");
        $finish;
      end
      #5;
      if (destination !== source) begin
        $display("FAIL specify after path delay");
        $finish;
      end
    end
    $display("PASS specify");
    $finish;
  end
endmodule
